import { parse } from "csv-parse";
import { DownloadStats, ExtensionType, IAvailableExtension, IExtensionManifest, IExtraInfo, ModDownloadStats, Rejected } from "./types";
import * as fs from 'fs-extra';
import * as path from 'path';
import Nexus, { IUpdateEntry, IModInfo, IFileInfo } from '@nexusmods/nexus-api';
import * as semver from 'semver';
import { CleanOptions, GitError, SimpleGit, simpleGit } from 'simple-git';
import { exit } from "process";
import 'dotenv/config';
import SlackClient from './SlackClient';
import { getEmojiStringFromExtensionType, getFormattedDate, parseMillisecondsIntoReadableTime } from './utils';
import Stopwatch from '@tsdotnet/stopwatch';
import { DOWNLOAD_STATS_URL, GAME_EXCLUSIONLIST, HTML_REGEX, LIVE_MANIFEST_URL, MANIFEST_FILENAME, ONE_DAY, SLACK_CHANNEL, VERSION_MATCH_REGEX, CATEGORIES, htmlMap } from './constants';



const REPO_ROOT_PATH: string = path.join(__dirname, '/../');
const PACKAGE_PATH = path.join(REPO_ROOT_PATH, 'package.json');

//const ANNOUNCEMENTS_BRANCH_NAME: string = 'announcements';
const MANIFEST_PATH: string = path.join(REPO_ROOT_PATH, 'out');
const MANIFEST_ARCHIVE_PATH: string = path.join(REPO_ROOT_PATH, 'archive');

const GAMES_REPO_NAME: string = 'vortex-games';
const GAMES_BRANCH_NAME: string = 'release';
const GAMES_REPO_URL: string = `https://github.com/Nexus-Mods/${GAMES_REPO_NAME}.git`;
const GAMES_LOCAL_PATH: string = path.join(REPO_ROOT_PATH, 'cloned', GAMES_REPO_NAME);

// env variables
const NEXUS_APIKEY:string = process.env.NEXUS_APIKEY || '' ;
//const DRYRUN:boolean = (process.env.DRYRUN === 'true') || false;

const slack = new SlackClient(SLACK_CHANNEL);

async function start() {

    console.log('Start Program');
        
    if (NEXUS_APIKEY === '') {
        console.error('No NEXUS_APIKEY found in env');
        process.exit(1);
    }

    const git: SimpleGit = simpleGit().clean(CleanOptions.FORCE);

    slack.sendInfo('Auto-update of the extensions manifest has started.')  
    
    console.log('MANIFEST_PATH', MANIFEST_PATH);

    // clone vortex-games repo for bundled game extensions
    try {
        await git.clone(GAMES_REPO_URL, GAMES_LOCAL_PATH, ['--single-branch', '--branch', GAMES_BRANCH_NAME]);
        console.log(`git cloned ${GAMES_REPO_URL}#${GAMES_BRANCH_NAME} to ${GAMES_LOCAL_PATH}`);

    } catch (err: any) {
        if (err.message.includes('already exists')) {
            // folder already exists, so lets pull down the latest as we don't need to clone
            console.warn(`${GAMES_LOCAL_PATH} already exists: ${err.message}`)
            await simpleGit(GAMES_LOCAL_PATH).pull();
            console.log('git pulled to ' + GAMES_LOCAL_PATH);
        } else {
            throw err;
        }
    }

    const driver = new Driver(NEXUS_APIKEY);
    await driver.process();
}




function dependenciesFromDescription(existing: { [key: string]: string }, description: string) {
    let versionRequirement = description.replace(HTML_REGEX, i => htmlMap[i]).match(VERSION_MATCH_REGEX);
    let result = existing;
    if (versionRequirement !== null) {
      if (result === undefined) {
        result = {};
      }
      result['vortex'] = versionRequirement[1];
    }
    return result;
  }


/**
 * Fetches latest download stats from NexusMods' live CSV file
 * @returns String-indexed object of mod ids and it's stats
 */
async function fetchDownloadStats(): Promise<DownloadStats> {
    const req = new Request(DOWNLOAD_STATS_URL, {
        method: 'GET',
        headers: new Headers(),
        mode: 'cors',
        cache: 'no-cache',
    });
    const data = await (await fetch(req)).text();
    const parsed = await csvParseAsync(data);
    // convert flat array to dictionary
    return parsed.reduce((accumulator: DownloadStats, current: ModDownloadStats) => {
        accumulator[current.modId] = { unique: current.unique, total: current.total };
        return accumulator;
    }, {});
}

/**
 * Parses the NexusMods' stats CSV and returns array of mod download stats
 * @param 'csv' string 
 * @returns Array of {@link ModDownloadStats}
 */
async function csvParseAsync(input: string): Promise<Array<ModDownloadStats>> {
    return new Promise((resolve, reject) => {
        parse(input, {
            columns: ['modId', 'total', 'unique', 'pageviews'],
            cast: (input) => parseInt(input, 10),
        }, (err, output) => {
            if (!!err) {
                console.error('parse error', err, input);
                reject(err);
            } else {
                resolve(output);
            }
        })
    });
}



class Driver {
  private manifest: IExtensionManifest;
  private nexusApiKey: string;
  private mPackage: any;

  constructor(nexusApiKey: string) {

    this.manifest = {
      last_updated: 0,
      extensions: [],
    };

    this.mPackage = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
    this.nexusApiKey = nexusApiKey;
  }

  private async readManifestFile(): Promise<IExtensionManifest> {
    return JSON.parse(await fs.readFile(path.join(MANIFEST_PATH, MANIFEST_FILENAME), { encoding: 'utf8' }));
  }

  private async writeManifestFile(data: any) {

    // create folder just in case doesn't exist
    if (!fs.existsSync(MANIFEST_ARCHIVE_PATH)) {
      fs.mkdirSync(MANIFEST_ARCHIVE_PATH, { recursive: true });
    }

    // write an archive file too?
    await fs.writeFile(path.join(MANIFEST_ARCHIVE_PATH, `${getFormattedDate(new Date())}_${MANIFEST_FILENAME}`), JSON.stringify(data, undefined, 2), 'utf-8');

    // write the main file
    await fs.writeFile(path.join(MANIFEST_PATH, MANIFEST_FILENAME), JSON.stringify(data, undefined, 2), 'utf-8');
  }

  public async process() {

    this.manifest = await this.readManifestFile();
    const now = Date.now();

    console.log('Start processing');
    console.log(`Last updated: ${new Date(this.manifest.last_updated).toString()}`);

    // get updates and new additions from the site
    await this.processNexusMods(this.mPackage);

    // get updated info from the vortex-games repo
    await this.processGames();

    // update last updated timestamp
    this.manifest.last_updated = now;

    console.log('Finished processing');

    // write the modified manifest object back to file
    await this.writeManifestFile(this.manifest);
  }


  public async processNexusMods(packageJson: any) {
    
    console.log('Processing NexusMods...');
    
    const stopwatch = Stopwatch.startNew();

    const nexus = await Nexus.create(this.nexusApiKey, 'update-extensions-manifest-action', packageJson.version, 'site');
    console.log(nexus.getRateLimits());

    // get all updates from the site since we last updated, as recorded in the latest version extensions file i.e. extensions_1_8.json
    // we end up with an array of mod ids that have been updated
    const lastUpdate = parseInt(process.env.UPDATE_CHECK_SINCE ?? this.manifest.last_updated.toString(), 10);

    let updates: number[] = (await this.getUpdatesSince(nexus, lastUpdate)).map((entry) => entry.mod_id);

    //console.log(updates);

    // get modids array of all mods that are currently in all manifests
    let knownMods: number[] = this.manifest.extensions.filter((extension) => extension.modId !== undefined).map((extension) => extension.modId as number);

    //console.log('knownMods', knownMods);

    // merge the two number arrays (one from site updates, one from local) but removing duplicates in the process
    const combinedMods = [...new Set([...updates, ...knownMods])];

    // should be the final list of modids that we need to check
    //console.log('combinedMods', combinedMods);

    let updatedExtensions: IAvailableExtension[] = [];
    let addedExtensions: IModInfo[] = [];

    // lets start getting the modinfo from the site and waiting til they are all returned
    await Promise.all(
      combinedMods.map(async (entry) => {
        let modInfo: IModInfo;

        try {
          console.log(`Fetching info for modid ${entry}...`);
          modInfo = await nexus.getModInfo(entry);
        } catch (err: any) {
          console.log(`${entry}: Fetch failed`, err.message);
          return Promise.resolve();
        }

        if (modInfo.picture_url === null) {
          console.error(`${entry}: Missing picture_url`, { modId: entry });
          return Promise.resolve();
        }

        if (modInfo.status !== 'published') {
          console.warn(`${entry}: Mod removed`, { modId: entry, status: modInfo.status });

          const existing = this.manifest.extensions.find((ext) => ext.modId === entry);

          if (existing !== undefined) {
            this.removeNexusMod(existing);
            //console.log('after removeNexusMod()', existing);
          }

          Object.keys(this.manifest).map((version) => {});

          return Promise.resolve();
        }

        const category: ExtensionType = CATEGORIES[modInfo.category_id];
        if (category === undefined) {
          // not in a category for Vortex extensions
          console.log(`${entry}: Not a game/theme/translation`, { category_id: modInfo.category_id });
          return Promise.resolve();
        }

        // now we need to get all file data for this mod so we can start checking versions etc
        const modFiles = await nexus.getModFiles(entry);

        //await Promise.all(Object.keys(this.mState).map(async version => {

        //const version = LATEST_VERSION;

        // get existing extension data for this file version
        const existing = this.manifest.extensions.find((ext) => ext.modId === entry);

        const refVersionLow = '1.8.0';
        const refVersionHigh = '1.8.999';

        // start checking all files associated with this mod (extension) and we need to end up with a single main file
        const mainFiles = modFiles.files.filter((file) => file.category_id === 1);

        let versionRequirement;

        const filteredFiles = mainFiles.filter((iter) => {
          versionRequirement = iter.description.replace(HTML_REGEX, (i) => htmlMap[i]).match(VERSION_MATCH_REGEX);
          if (versionRequirement === null) {
            return true;
          }
          console.log('ref version', { refVersionLow, refVersionHigh, req: versionRequirement[1] });
          return semver.satisfies(refVersionLow, versionRequirement[1]) || semver.satisfies(refVersionHigh, versionRequirement[1]);
        });

        if (filteredFiles.length > 1) {
          console.error(`${entry}: Multiple main files, only the latest will be included`, { modId: modInfo.mod_id });
        } else if (filteredFiles.length === 0) {
          if (mainFiles.length > 0) {
            console.error(`${entry}: All files filtered because of version requirement`, { versionRequirement });
          } else {
            console.error(`${entry}: Mod has no main file`);

            slack.sendWarning(`${entry}: Mod has no main file`);
          }

          if (existing !== undefined) {
            // there already is a file which seems to be unlisted now
            this.removeNexusMod(existing);
          }

          return;
        }

        // this should be the most recent main file for this mod
        const latestFile = filteredFiles.sort((lhs, rhs) => rhs.file_id - lhs.file_id)[0];

        console.error(`${entry}: Latest File`, { file_id: latestFile.file_id });

        // now we have the main and latest file for the mod
        try {

          //let supported = SUPPORTED_VERSIONS.includes(LATEST_VERSION as Versions);

          if (existing !== undefined) {
            // existing extension
            console.log(`${entry}: Exists already`, { version: existing.version, fileId: existing.fileId });

            let type = existing.type;
            let extraInfo: IExtraInfo = {
              language: existing.language,
              gameName: existing.gameName,
            };

            let updated = existing.fileId !== latestFile.file_id;

            if (updated) {
              //if (supported) {
                console.log(`${entry}: File updated`, { old: existing.fileId, new: latestFile.file_id });

                //const res = await this.confirm(modInfo, latestFile);
                //type = res.type;
                //extraInfo = res.extraInfo;

                existing.fileId = latestFile.file_id;

                // add to updated array
                updatedExtensions.push(existing);
              //} else {
              //  //console.log(`${entry}: File update ignored for unsupported version`, { LATEST_VERSION });
              //}
            }

            if (updated || existing.name !== undefined) {
              //if (supported) {
                // make a new extension and then assign to existing. saves us duplicating code
                Object.assign(existing, this.makeExtension(modInfo, latestFile, type!, extraInfo));

                existing.version = latestFile.version;
              //} else {
                // for unsupported versions, update only the download and endorsement count
                //const dlStat: { unique?: number } = downloadStats[modInfo.mod_id.toString()] || {};
              //  existing.downloads = modInfo.mod_unique_downloads || 0;
              //  existing.endorsements = modInfo.endorsement_count || 0;
              //}

              // update fields, doesn't really matter whether they've changed
              existing.description = {
                short: modInfo.summary ?? '',
                long: modInfo.description ?? '',
              };
              existing.image = modInfo.picture_url ?? existing.image;
              existing.name = modInfo.name;
              existing.uploader = modInfo.uploaded_by;
              existing.type = type;
              existing.timestamp = latestFile.uploaded_timestamp;

              existing.dependencies = dependenciesFromDescription(existing.dependencies!, latestFile.description);
            }
          } else {
            // new extension

            //if (supported) {
              // We are pushing this to live now, but only for updating extesnions. We need to tell slack that a new extension needs to be added manually ready for next working day.

              /* TODO really need to work out how to handle new extensions as there are no known connections on the site that links
               * the extension and what game it is associated with. A 'game name' is needed so we can display it in the Vortex > Games tab and
               * that currently exists, at this point, inside of the index.js file and the .registerGame function along with the site domain name.
               * When the extension is installed, and the index.js is run, that is when the connection is made between extension and game.
               *
               * This will be different if a theme and a translation, we can do prob do certain checks to see what type of extension it is?
               *
               * theme will contain scss files etc. game should contain more meta. translation diff folders.
               */

              const extensionType: ExtensionType = CATEGORIES[modInfo.category_id];

              addedExtensions.push(modInfo);

              // SLACK BOT MESSAGE
              /*
                                sendSlackMessage(SlackMessageType.Warning, `<https://www.nexusmods.com/site/mods/${entry}|${modInfo.name} (${extensionType})>\n
                                This has been uploaded to the site but won't be automatically published on the announcement repo. This will need adding manually ASAP.\n
                                \`modid=${entry}\``)*/

              // this is where need to do extra stuff with translations and games.
              // games need a gameName and translations need a language code
              /**
                                 * const extraInfo: IExtraInfo = { gameName: 'Game Name' }
                                 * const extraInfo: IExtraInfo = { language: 'en' }
                                 
                                //const extraInfo: IExtraInfo = { gameName: 'game name' }

                                // SLACK BOT MESSAGE WARNING
                                if(this.mSlack !== undefined) {
                                    this.mSlack.client.chat.postMessage({
                                        channel: 'C05009EK5R6',
                                        text: `[${version}] ${entry}: New extension has been added. Will be worth manually checking.`,
                                        icon_emoji: ':white_tick:'
                                    })
                                }

                                const newExt = this.makeExtension(modInfo, latestFile, extensionType, extraInfo);
                                newExt.dependencies = dependenciesFromDescription(newExt.dependencies ?? {}, latestFile.description);
                                
                                // add new entry to existing state
                                this.mState[version].extensions.push(newExt);                             

                                console.log(`${entry}: New extension:`, {
                                    modInfo: modInfo,
                                    newExt: newExt
                                 });
                        */
            //} else {
            //  console.log(`${entry}: New extension ignored for unsupported version`, { modId: entry });
            //}
          }
        } catch (err: any) {
          if (err instanceof Rejected) {
            if (existing !== undefined) {
              existing.fileId = latestFile.file_id;
            } else {
              this.manifest.extensions.push({ modId: entry, fileId: latestFile.file_id });
            }
            console.log(`${entry}: Rejected`, { modId: entry, fileId: latestFile.file_id });
          } else {
            console.trace('failed to update', entry, err.message);
            console.log(`${entry}: Failed to update`, { modId: entry, error: err.message });
          }
        }

        //}));

        console.log(`${entry}: Fetch successful`);
        return Promise.resolve();
      })
    );

    // all mods have been processed

    sendSlackSummary(addedExtensions, updatedExtensions, stopwatch.elapsedMilliseconds);    

    console.log('processNexusMods done');
  }

  private async processGames() {

    console.log(`Processing Games...`);

    // get array of all directories for game extensions
    const gameList: string[] = (await fs.readdir(GAMES_LOCAL_PATH)).filter((dirName) => dirName.startsWith('game-') && !GAME_EXCLUSIONLIST.includes(dirName));

    console.log(`gameList`, { games: JSON.stringify(gameList) });

    await Promise.all(
      gameList.map(async (gameId) => {
        const info = JSON.parse(await fs.readFile(path.join(GAMES_LOCAL_PATH, gameId, 'info.json'), 'utf8'));

        let existing = this.manifest.extensions.find((ext) => ext.modId === undefined && ext.id === (info.id || gameId));

        if (existing === undefined) {
          existing = {
            image: `https://raw.githubusercontent.com/Nexus-Mods/vortex-games/${GAMES_BRANCH_NAME}/${gameId}/gameart.jpg`,
            name: info.name,
            type: 'game',
            github: 'Nexus-Mods/vortex-games',
            githubRawPath: gameId,
          };
          this.manifest.extensions.push(existing);
        }
        existing.id = info.id || gameId;

        existing.hide = true;

        // quite hacky: We always name the extension "Game: <game name>"
        existing.author = info.author;
        existing.gameName = info.name.slice(6);
        /*
            try {
              existing.gameId = await gameIdFromExtension(path.join(gamesWCPath, gameId));
            } catch (err) {
              this.mLog('warn', 'failed to determine game id', { gamesWCPath, gameId });
            }
            */
        existing.description = {
          short: info.description,
          long: info.description,
        };

        // the only thing we really need to update is the version
        existing.version = info.version;

        console.log(`Completed ${gameId} (${info.version})`);
      })
    );

    console.log(`Games have been processed.`);
  }

  private removeNexusMod(entry: IAvailableExtension) {
    // we don't actually remove the entry in the manifest, we just reduce the object to just the modId and fileId
    Object.keys(entry).forEach((key) => {
      if (!['modId', 'fileId'].includes(key)) {
        delete entry[key as keyof IAvailableExtension];
      }
    });
  }

  /**
   * Gets updates from Nexus
   * @param nexus Nexus API object
   * @param timestamp Timestamp to check from
   * @returns Array of {@link IUpdateEntry}
   */
  private async getUpdatesSince(nexus: Nexus, timestamp: number): Promise<IUpdateEntry[]> {
    const elapsed = Date.now() - timestamp;

    // need to decide what range to get from the site
    const range = elapsed <= ONE_DAY ? '1d' : elapsed <= ONE_DAY * 7 ? '1w' : '1m';

    if (elapsed > ONE_DAY * 30) {
      console.error('Last update was more than one month ago, list may be incomplete!');
    }

    console.log('update range', { range, timestamp });

    // get array of all mods that have updated within the range of 1d, 1w or 1m
    let updates;

    try {
      updates = await nexus.getRecentlyUpdatedMods(range);
    } catch (err: any) {
      console.error(err);

      slack.sendError(err);

      process.exit(1);
    }
    //const updates = await nexus.getRecentlyUpdatedMods(range);
    const updatesJson = JSON.stringify(updates, undefined, 2);
    //fs.writeFileSync('updated.json', updatesJson, 'utf8');
    console.log('updatesJson', updatesJson);

    // filtering down by anything that is newer than our last update
    const filtered = updates.filter((entry) => entry.latest_file_update > timestamp / 1000 || entry.latest_mod_activity > timestamp / 1000);

    console.log('filtered', filtered);

    return filtered;
  }

  private makeExtension(modInfo: IModInfo, file: IFileInfo, type: ExtensionType, extraInfo: IExtraInfo) {
    //const dlStat: { unique?: number } = dlStats[modInfo.mod_id.toString()] || {};

    let result: IAvailableExtension = {
      modId: modInfo.mod_id,
      fileId: file.file_id,
      author: modInfo.author,
      uploader: modInfo.uploaded_by,
      description: {
        short: modInfo.summary ?? '',
        long: modInfo.description ?? '',
      },
      //downloads: dlStat.unique || 0,
      downloads: modInfo.mod_unique_downloads,
      endorsements: (modInfo as any).endorsement_count,
      image: modInfo.picture_url,
      name: modInfo.name,
      timestamp: file.uploaded_timestamp,
      tags: [],
      version: file.version,
      type,
      gameName: extraInfo.gameName,
      language: extraInfo.language,
    };

    return result;
  }
}




function sendSlackSummary(addedExtensions: IModInfo[], updatedExtensions: IAvailableExtension[], duration: number) {

  let added: string[] = [];
  let updated: string[] = [];

  // process added extensions and prepare for slack
  if (addedExtensions.length !== 0) {
    added = addedExtensions.map((mod) => {
        return `${getEmojiStringFromExtensionType(CATEGORIES[mod.category_id])} <https://www.nexusmods.com/site/mods/${mod.mod_id}|${mod.name}> - ${mod.version}`;
      });
  } else {
    console.log('No extensions have been added.');
  }

  // process updated extensions and prepare for slack
  if (updatedExtensions.length !== 0) {

    updated = updatedExtensions.map((ext) => {
      return `${getEmojiStringFromExtensionType(ext.type)} <https://www.nexusmods.com/site/mods/${ext.modId}|${ext.name}> - ${ext.version}`;
    });

  } else {
    console.log('No extensions have had files updated.');
  }

  // build slack blocks for message

  const headerBlock: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Extensions <${LIVE_MANIFEST_URL}|manifest file> has been updated`,
      },
    },
  ];

  const noExtensionChanges: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No extensions have been added or updated',
      },
    },
  ]

  const addedExtensionsBlock: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Extensions that need adding:*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: added.join('\n'),
      },
    }
  ];

  const updatedExtensionsBlock: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Extensions that have been updated:*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: updated.join('\n'),
      },
    }
  ];

  const footerBlock: any[] = [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Completed in ${parseMillisecondsIntoReadableTime(duration)}`,
        },
      ],
    }
  ];

  let blocks = [...headerBlock];

  if (addedExtensions.length > 0) 
  blocks = blocks.concat(addedExtensionsBlock);

  if (updatedExtensions.length > 0) 
  blocks = blocks.concat(updatedExtensionsBlock);

  if (addedExtensions.length === 0 && updatedExtensions.length === 0) 
  blocks = blocks.concat(noExtensionChanges);

  blocks = blocks.concat(footerBlock);

  slack.sendMessage('summary', blocks);
}

start();