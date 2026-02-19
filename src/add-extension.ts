import { ExtensionType, IAvailableExtension, IExtensionManifest } from './types';
import * as fs from 'fs-extra';
import * as path from 'path';
import Nexus, { IUpdateEntry, IModInfo, IFileInfo, IGameInfo } from '@nexusmods/nexus-api';
import { simpleGit, SimpleGit, CleanOptions } from 'simple-git';
import 'dotenv/config';
import SlackClient from './SlackClient';
import Stopwatch from '@tsdotnet/stopwatch';
import { getEmojiStringFromExtensionType, getFormattedDate, parseMillisecondsIntoReadableTime } from './utils';
import { CATEGORIES, LIVE_MANIFEST_URL, SLACK_CHANNEL } from './constants';

const MANIFEST_FILENAME = 'extensions-manifest.json';

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');
const PACKAGE_PATH = path.join(REPO_ROOT_PATH, 'package.json');

const MANIFEST_PATH: string = path.join(REPO_ROOT_PATH, 'out');
const MANIFEST_ARCHIVE_PATH: string = path.join(REPO_ROOT_PATH, 'archive');

// env variables
const NEXUS_APIKEY = process.env.NEXUS_APIKEY || '';
const EXT_MODID = process.env.EXT_MODID || '';
const EXT_TYPE = process.env.EXT_TYPE || '';
const EXT_GAMEDOMAIN = process.env.EXT_GAMEDOMAIN || '';
const EXT_LANGUAGE_CODE = process.env.EXT_LANGUAGE_CODE || '';
//const DRYRUN:boolean = (process.env.DRYRUN === 'true') || false;

const slack = new SlackClient(SLACK_CHANNEL);

async function start() {

  console.log('Start Program');

  if (NEXUS_APIKEY === '') {
    console.error("No Nexus API Key found in env");
    process.exit(1);
  }

  if (EXT_MODID === '') {
    console.error('No EXT_MODID found in env');
    process.exit(1);
  }

  const driver = new Driver(NEXUS_APIKEY);
  await driver.process();
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

    // update last updated timestamps
    this.manifest.last_updated = now;
    
    console.log('Finished processing');

    // write the modified manifest object back to file
    await this.writeManifestFile(this.manifest);
  }

  public async processNexusMods(packageJson: any) {

    console.log('Processing NexusMods...');
    
    const stopwatch = Stopwatch.startNew();

    const nexus = await Nexus.create(this.nexusApiKey, 'add-extension-action', packageJson.version, 'site');
    console.log(nexus.getRateLimits());

    /**
     * this is where I think we want to get the info from the environment varaibles
     */
    console.log('main env variables', {
        EXT_MODID: EXT_MODID, 
        EXT_TYPE: EXT_TYPE, 
        EXT_GAMEDOMAIN: EXT_GAMEDOMAIN, 
        EXT_LANGUAGE_CODE: EXT_LANGUAGE_CODE});

    const modid: number = +EXT_MODID;

    // if it already exists, then do we need to do any of this?!

    let modInfo: IModInfo;

    // get mod info from the id
    try {
      console.log(`Fetching mod info for modid=${modid}...`);
      modInfo = await nexus.getModInfo(modid);
      console.log('modInfo', modInfo);
    } catch (err: any) {
      console.log(`${modid}: nexus.getModInfo failed`, err.message);
      process.exit(1);
    }

    // some checks to make sure it's available and can be used

    if (modInfo.status !== 'published') {
      console.warn(`${modid}: Mod removed`, { modid: modid, status: modInfo.status });
      process.exit(1);
    }

    const extensionType: ExtensionType = CATEGORIES[modInfo.category_id];

    if (extensionType === undefined) {
      // not in a category for Vortex extensions
      console.error(`${modid}: Not a game/theme/translation`, { category_id: modInfo.category_id });
      process.exit(1);
    }

    // now we need to get all file data for this mod so we can start checking versions etc
    const modFiles = await nexus.getModFiles(modid);

    // start checking all files associated with this mod (extension) and we need to end up with a single main file
    const mainFiles = modFiles.files.filter((file) => file.category_id === 1);
    
    if (mainFiles.length > 1) {
      console.log(`${modid}: Multiple main files, only the latest will be included`, { modId: modInfo.mod_id });
    } else if (mainFiles.length === 0) {
      console.error(`${modid}: Mod has no main file`);
      process.exit(1);
    }

    // this should be the most recent main file for this mod
    const latestFile = mainFiles.sort((lhs, rhs) => rhs.file_id - lhs.file_id)[0];

    console.log('latestFile', latestFile);

    // now we have the main and latest file for the mod
    let newManifestEntry: IAvailableExtension;

    // this could be a tool or a game
    if (extensionType === 'game') {

      // if no game supplied then we have to assume it's a tool?

      if (EXT_GAMEDOMAIN !== '') { // it's a game       

        // if supplied with a gamedomain, then we go get the gamepage info
        let gameInfo: IGameInfo | undefined;

        try {
          console.log(`Fetching game info for gamedomain='${EXT_GAMEDOMAIN}'...`);
          gameInfo = await nexus.getGameInfo(EXT_GAMEDOMAIN);
          console.log('gameInfo', gameInfo);
          newManifestEntry = this.createManifestEntryForGame(modInfo, latestFile, extensionType, gameInfo);
        } catch (err: any) {
          console.log(`${EXT_GAMEDOMAIN}: nexus.getGameInfo failed`, err.message);
          process.exit(1);
        }
      } else { //it's a tool        
        newManifestEntry = this.createManifestEntryForTool(modInfo, latestFile, extensionType);
      }
    } else if (extensionType === 'translation') { // it's a translation

      if (EXT_LANGUAGE_CODE === '') {
        console.error('No EXT_LANGUAGE_CODE found in env');
        process.exit(1);
      }

      newManifestEntry = this.createManifestEntryForTranslation(modInfo, latestFile, extensionType, EXT_LANGUAGE_CODE);
    } else { // it's a theme

      newManifestEntry = this.createManifestEntryForTheme(modInfo, latestFile, extensionType);
    }

    console.log('newManifestEntry', newManifestEntry);

    // get existing extension data for this file version
    // we are doing this at the end so we can debug everything else
    const existing = this.manifest.extensions.find((ext) => ext.modId === modid);

    if (existing !== undefined) {
      console.error(`${modid}: Manifest already contains this extension`, { modId: modid });
      process.exit(1);
    }

    // add new entry to existing state
    this.manifest.extensions.push(newManifestEntry);

    console.log(`${modid}: Fetch successful`);
    
    //
    sendSlackSummary(newManifestEntry, stopwatch.elapsedMilliseconds);   

    console.log('processNexusMods done');
  }


  private createManifestEntryForTool(modInfo: IModInfo, file: IFileInfo, type: ExtensionType): IAvailableExtension {
    let extension = this.getManifestEntryTemplate(modInfo, file, type);

    // null as it's a tool?
    extension.type = null;

    return extension;
  }

  private createManifestEntryForGame(modInfo: IModInfo, file: IFileInfo, type: ExtensionType, gameInfo: IGameInfo): IAvailableExtension {
    let extension = this.getManifestEntryTemplate(modInfo, file, type);

    // use image from game page not from extension page
    extension.image = modInfo.picture_url ?? `https://staticdelivery.nexusmods.com/images/games/4_3/tile_${gameInfo.id}.jpg`;

    // use game name from game page
    extension.gameName = gameInfo.name;

    // store the game domain for Nexus URL construction
    extension.gameId = gameInfo.domain_name;

    return extension;
  }

  private createManifestEntryForTheme(modInfo: IModInfo, file: IFileInfo, type: ExtensionType): IAvailableExtension {
    return this.getManifestEntryTemplate(modInfo, file, type);
  }

  private createManifestEntryForTranslation(modInfo: IModInfo, file: IFileInfo, type: ExtensionType, languageTag: string): IAvailableExtension {
    let extension = this.getManifestEntryTemplate(modInfo, file, type);

    // set language from supplied tag
    extension.language = languageTag;

    return extension;
  }

  private getManifestEntryTemplate(modInfo: IModInfo, file: IFileInfo, type: ExtensionType): IAvailableExtension {
    return {
      modId: modInfo.mod_id,
      fileId: file.file_id,
      author: modInfo.author,
      uploader: modInfo.uploaded_by,
      description: {
        short: modInfo.summary ?? '',
        long: modInfo.description ?? '',
      },
      downloads: modInfo.mod_unique_downloads,
      endorsements: (modInfo as any).endorsement_count,
      image: modInfo.picture_url,
      name: modInfo.name,
      timestamp: file.uploaded_timestamp,
      tags: [],
      version: file.version,
      type,
    };
  }
}

function sendSlackSummary(newManifestEntry: IAvailableExtension, duration: number) {

    const added = `${getEmojiStringFromExtensionType(newManifestEntry.type)} <https://www.nexusmods.com/site/mods/${newManifestEntry.modId}|${newManifestEntry.name}> - ${newManifestEntry.version}`;
  
    // build slack blocks for message
  
    const headerBlock: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${LIVE_MANIFEST_URL}|Extensions manifest file> has been updated`,
        },
      },
    ];

    const addedExtensionsBlock: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Added extensions:*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: added,
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
  
    let blocks = [...headerBlock, ...addedExtensionsBlock, ...footerBlock];
  
    slack.sendMessage('summary', blocks);
  }

start();
