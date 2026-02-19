import { ExtensionType, IAvailableExtension, IExtensionManifest } from './types';
import * as fs from 'fs-extra';
import * as path from 'path';
import Nexus, { IModInfo, IFileInfo, IGameInfo } from '@nexusmods/nexus-api';
import 'dotenv/config';
import SlackClient from './SlackClient';
import Stopwatch from '@tsdotnet/stopwatch';
import { getEmojiStringFromExtensionType, getFormattedDate, parseMillisecondsIntoReadableTime } from './utils';
import { CATEGORIES, LIVE_MANIFEST_URL, SLACK_CHANNEL, MANIFEST_FILENAME } from './constants';
import { readExtensionReviewRequests, IExtensionReviewRequest } from './read-extension-review-requests';
import { validateManifestEntry, normalizeManifestEntry } from './validate-manifest-entry';

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');
const PACKAGE_PATH = path.join(REPO_ROOT_PATH, 'package.json');
const MANIFEST_PATH: string = path.join(REPO_ROOT_PATH, 'out');
const MANIFEST_ARCHIVE_PATH: string = path.join(REPO_ROOT_PATH, 'archive');
const DOWNLOADS_PATH: string = path.join(REPO_ROOT_PATH, 'review-downloads');

// env variables
const NEXUS_APIKEY = process.env.NEXUS_APIKEY || process.env.NEXUS_API_KEY || '';
const DRYRUN: boolean = (process.env.DRYRUN === 'true') || false;
const DOWNLOAD_FOR_REVIEW: boolean = (process.env.DOWNLOAD_FOR_REVIEW === 'true') || false;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

// Only initialize Slack if credentials are available
let slack: SlackClient | null = null;
if (SLACK_SIGNING_SECRET && SLACK_BOT_TOKEN) {
  slack = new SlackClient(SLACK_CHANNEL);
} else {
  console.log('Slack credentials not found - notifications will be skipped\n');
}

interface IPackageJson {
  name: string;
  version: string;
  [key: string]: any;
}

interface IProcessingResult {
  request: IExtensionReviewRequest;
  success: boolean;
  entry?: IAvailableExtension;
  error?: string;
  downloadPath?: string;
}

function exitWithError(message: string, context?: any): never {
  console.error(message, context || '');
  process.exit(1);
}

async function start() {
  console.log('Starting batch processing of extension review requests...\n');

  if (NEXUS_APIKEY === '') {
    exitWithError("No Nexus API Key found in env");
  }

  const processor = new BatchProcessor(NEXUS_APIKEY);
  await processor.process();
}

class BatchProcessor {
  private manifest!: IExtensionManifest;
  private nexusApiKey: string;
  private mPackage!: IPackageJson;

  constructor(nexusApiKey: string) {
    this.nexusApiKey = nexusApiKey;
  }

  private async init(): Promise<void> {
    this.mPackage = JSON.parse(await fs.readFile(PACKAGE_PATH, 'utf8'));
  }

  private async readManifestFile(): Promise<IExtensionManifest> {
    return JSON.parse(await fs.readFile(path.join(MANIFEST_PATH, MANIFEST_FILENAME), { encoding: 'utf8' }));
  }

  private async writeManifestFile(data: IExtensionManifest) {
    if (DRYRUN) {
      console.log('\nDRY RUN: Would have written manifest file');
      console.log(`Total extensions: ${data.extensions.length}`);
      return;
    }

    // create folder (recursive flag handles existence check)
    await fs.mkdirp(MANIFEST_ARCHIVE_PATH);

    // write an archive file
    await fs.writeFile(
      path.join(MANIFEST_ARCHIVE_PATH, `${getFormattedDate(new Date())}_${MANIFEST_FILENAME}`),
      JSON.stringify(data, undefined, 2),
      'utf-8'
    );

    // write the main file
    await fs.writeFile(
      path.join(MANIFEST_PATH, MANIFEST_FILENAME),
      JSON.stringify(data, undefined, 2),
      'utf-8'
    );
  }

  public async process() {
    const stopwatch = Stopwatch.startNew();

    await this.init();
    this.manifest = await this.readManifestFile();

    console.log('Current manifest info:');
    console.log(`Last updated: ${new Date(this.manifest.last_updated).toString()}`);
    console.log(`Total extensions: ${this.manifest.extensions.length}\n`);

    // Setup downloads directory if needed
    if (DOWNLOAD_FOR_REVIEW) {
      await fs.mkdirp(DOWNLOADS_PATH);
      console.log(`Download mode enabled. Files will be saved to: ${DOWNLOADS_PATH}\n`);
    }

    // Read all queued review requests
    console.log('Fetching extension review requests from GitHub...\n');
    const requests = await readExtensionReviewRequests();

    if (requests.length === 0) {
      console.log('No queued extension review requests found. Exiting.');
      return;
    }

    console.log(`Found ${requests.length} queued extension review request(s)\n`);

    // Process each request
    const results: IProcessingResult[] = [];
    const nexus = await Nexus.create(this.nexusApiKey, 'process-review-requests', this.mPackage.version, 'site');

    console.log('Initial Nexus API rate limits:', nexus.getRateLimits());
    console.log('');

    for (const request of requests) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Processing Issue #${request.issueNumber}: ${request.title}`);
      console.log(`${'='.repeat(80)}`);

      const result = await this.processRequest(request, nexus);
      results.push(result);

      // Add a small delay between requests to avoid rate limiting
      if (requests.indexOf(request) < requests.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Update manifest with successful additions
    const successful = results.filter(r => r.success && r.entry);

    if (successful.length > 0) {
      console.log(`\n\n${'='.repeat(80)}`);
      console.log('SUMMARY');
      console.log(`${'='.repeat(80)}\n`);

      console.log(`Successfully processed: ${successful.length}/${results.length} extensions`);

      // Add new entries to manifest
      for (const result of successful) {
        if (result.entry) {
          this.manifest.extensions.push(result.entry);
          console.log(`Added: ${result.entry.name} (Mod ID: ${result.entry.modId})`);
          if (result.downloadPath) {
            console.log(`  Downloaded to: ${result.downloadPath}`);
          }
        }
      }

      // Update timestamp
      this.manifest.last_updated = Date.now();

      // Write updated manifest
      await this.writeManifestFile(this.manifest);

      console.log(`\nManifest updated successfully!`);
      console.log(`Total extensions in manifest: ${this.manifest.extensions.length}`);

      // Send Slack notification
      if (!DRYRUN && slack) {
        await this.sendSlackSummary(successful, stopwatch.elapsedMilliseconds);
      } else if (!DRYRUN) {
        console.log('\nSkipping Slack notification (no credentials)');
      }
    }

    // Show failures
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      console.log(`\nFailed to process: ${failed.length}/${results.length} extensions`);
      for (const result of failed) {
        console.log(`Issue #${result.request.issueNumber}: ${result.error}`);
      }
    }

    console.log(`\nCompleted in ${parseMillisecondsIntoReadableTime(stopwatch.elapsedMilliseconds)}`);
  }

  private async processRequest(
    request: IExtensionReviewRequest,
    nexus: Nexus
  ): Promise<IProcessingResult> {
    try {
      const { reviewDetails } = request;

      // Validate required fields
      if (!reviewDetails.extensionModId) {
        return {
          request,
          success: false,
          error: 'Missing extension mod ID',
        };
      }

      const modId = parseInt(reviewDetails.extensionModId, 10);

      // Check if already in manifest
      const existing = this.manifest.extensions.find(ext => ext.modId === modId);
      if (existing !== undefined) {
        return {
          request,
          success: false,
          error: `Extension already exists in manifest (Mod ID: ${modId})`,
        };
      }

      // Fetch mod info from Nexus
      console.log(`Fetching mod info for Mod ID ${modId}...`);
      let modInfo: IModInfo;

      try {
        modInfo = await nexus.getModInfo(modId);
      } catch (err: any) {
        return {
          request,
          success: false,
          error: `Failed to fetch mod info: ${err.message}`,
        };
      }

      // Validate mod status
      if (modInfo.status !== 'published') {
        return {
          request,
          success: false,
          error: `Mod is not published (status: ${modInfo.status})`,
        };
      }

      // Validate extension type
      const extensionType: ExtensionType = CATEGORIES[modInfo.category_id];
      if (extensionType === undefined) {
        return {
          request,
          success: false,
          error: `Not a valid extension category (category_id: ${modInfo.category_id})`,
        };
      }

      console.log(`Extension type: ${extensionType || 'tool'}`);

      // Fetch mod files
      console.log(`Fetching mod files...`);
      const modFiles = await nexus.getModFiles(modId);
      const mainFiles = modFiles.files.filter(file => file.category_id === 1);

      if (mainFiles.length === 0) {
        return {
          request,
          success: false,
          error: 'Mod has no main file',
        };
      }

      if (mainFiles.length > 1) {
        console.log(`Warning: Multiple main files found, using latest`);
      }

      // Get the latest main file
      const latestFile = mainFiles.reduce((latest, current) =>
        current.file_id > latest.file_id ? current : latest
      );

      console.log(`Latest file: ${latestFile.name} (v${latestFile.version})`);

      // Create manifest entry based on type
      let newManifestEntry: IAvailableExtension;

      if (extensionType === 'game') {
        // Check if it's a tool or game extension
        if (reviewDetails.gameDomain) {
          // It's a game extension
          console.log(`Fetching game info for domain: ${reviewDetails.gameDomain}...`);
          let gameInfo: IGameInfo;

          try {
            gameInfo = await nexus.getGameInfo(reviewDetails.gameDomain);
          } catch (err: any) {
            return {
              request,
              success: false,
              error: `Failed to fetch game info for '${reviewDetails.gameDomain}': ${err.message}`,
            };
          }

          console.log(`Game: ${gameInfo.name}`);
          newManifestEntry = this.createManifestEntryForGame(modInfo, latestFile, extensionType, gameInfo);
        } else {
          // It's a tool
          console.log(`Creating tool entry (no game domain)`);
          newManifestEntry = this.createManifestEntryForTool(modInfo, latestFile, extensionType);
        }
      } else if (extensionType === 'translation') {
        // For translations, we need a language code
        // Try to extract from the review details or use a default
        const languageCode = 'en'; // TODO: Extract from issue or ask for it
        console.log(`Warning: Using default language code 'en' for translation`);
        newManifestEntry = this.createManifestEntryForTranslation(modInfo, latestFile, extensionType, languageCode);
      } else {
        // It's a theme
        newManifestEntry = this.createManifestEntryForTheme(modInfo, latestFile, extensionType);
      }

      // Normalize and validate the entry
      const normalizedEntry = normalizeManifestEntry(newManifestEntry);
      const validation = validateManifestEntry(normalizedEntry);

      if (!validation.valid) {
        console.log(`Entry validation failed:`);
        validation.errors.forEach(err => console.log(` - ${err}`));
        return {
          request,
          success: false,
          error: `Entry validation failed: ${validation.errors.join(', ')}`,
        };
      }

      console.log(`Successfully validated extension`);

      // Download file for review if enabled
      let downloadPath: string | undefined;
      if (DOWNLOAD_FOR_REVIEW) {
        try {
          downloadPath = await this.downloadExtensionFile(modId, latestFile, nexus);
          console.log(`Downloaded to: ${downloadPath}`);
        } catch (err: any) {
          console.log(`Warning: Failed to download file: ${err.message}`);
        }
      }

      return {
        request,
        success: true,
        entry: normalizedEntry,
        downloadPath,
      };

    } catch (err: any) {
      return {
        request,
        success: false,
        error: `Unexpected error: ${err.message}`,
      };
    }
  }

  private async downloadExtensionFile(
    modId: number,
    file: IFileInfo,
    nexus: Nexus
  ): Promise<string> {
    // Create folder structure: review-downloads/modId-modName/
    const sanitizedFileName = file.name.replace(/[<>:"/\\|?*]/g, '_');
    const folderName = `${modId}-${sanitizedFileName}`;
    const downloadFolder = path.join(DOWNLOADS_PATH, folderName);

    await fs.mkdirp(downloadFolder);

    // Get download links
    console.log(`Requesting download link for file ID ${file.file_id}...`);
    const downloadLinks = await nexus.getDownloadURLs(modId, file.file_id);

    if (!downloadLinks || downloadLinks.length === 0) {
      throw new Error('No download links available');
    }

    // Use the first download link
    const downloadUrl = downloadLinks[0].URI;
    const filePath = path.join(downloadFolder, file.file_name);

    console.log(`Downloading ${file.file_name}...`);

    // Download the file using node's https module
    const https = require('https');
    const http = require('http');

    return new Promise<string>((resolve, reject) => {
      const protocol = downloadUrl.startsWith('https') ? https : http;
      const fileStream = fs.createWriteStream(filePath);

      protocol.get(downloadUrl, (response: any) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;

        response.on('data', (chunk: Buffer) => {
          downloadedSize += chunk.length;
          if (totalSize > 0) {
            const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
            process.stdout.write(`\rDownload progress: ${percent}%`);
          }
        });

        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          if (totalSize > 0) {
            process.stdout.write('\n');
          }
          resolve(filePath);
        });
      }).on('error', (err: Error) => {
        fs.unlink(filePath, () => {}); // Clean up partial download
        reject(err);
      });

      fileStream.on('error', (err: Error) => {
        fs.unlink(filePath, () => {}); // Clean up partial download
        reject(err);
      });
    });
  }

  private createManifestEntryForTool(modInfo: IModInfo, file: IFileInfo, type: ExtensionType): IAvailableExtension {
    const extension = this.getManifestEntryTemplate(modInfo, file, type);
    extension.type = null; // null indicates a tool
    return extension;
  }

  private createManifestEntryForGame(
    modInfo: IModInfo,
    file: IFileInfo,
    type: ExtensionType,
    gameInfo: IGameInfo
  ): IAvailableExtension {
    const extension = this.getManifestEntryTemplate(modInfo, file, type);

    // Use image from game page not from extension page
    extension.image = modInfo.picture_url ?? `https://staticdelivery.nexusmods.com/images/games/4_3/tile_${gameInfo.id}.jpg`;

    // Use game name from game page
    extension.gameName = gameInfo.name;

    // Store the game domain for Nexus URL construction
    extension.gameId = gameInfo.domain_name;

    return extension;
  }

  private createManifestEntryForTheme(modInfo: IModInfo, file: IFileInfo, type: ExtensionType): IAvailableExtension {
    return this.getManifestEntryTemplate(modInfo, file, type);
  }

  private createManifestEntryForTranslation(
    modInfo: IModInfo,
    file: IFileInfo,
    type: ExtensionType,
    languageTag: string
  ): IAvailableExtension {
    const extension = this.getManifestEntryTemplate(modInfo, file, type);
    extension.language = languageTag;
    return extension;
  }

  private getManifestEntryTemplate(modInfo: IModInfo, file: IFileInfo, type: ExtensionType): IAvailableExtension {
    // Follow exact field order from reference manifest entry
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

  private async sendSlackSummary(results: IProcessingResult[], duration: number) {
    if (!slack) {
      console.log('Slack client not initialized - skipping notification');
      return;
    }
    const blocks = this.buildSlackBlocks(results, duration);
    await slack.sendMessage('batch-processing-summary', blocks);
  }

  private buildSlackBlocks(results: IProcessingResult[], duration: number): any[] {
    const extensionLinks = results
      .filter(r => r.entry)
      .map(r => {
        const ext = r.entry!;
        const emoji = getEmojiStringFromExtensionType(ext.type);
        return `${emoji} <https://www.nexusmods.com/site/mods/${ext.modId}|${ext.name}> - ${ext.version}`;
      });

    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${LIVE_MANIFEST_URL}|Extensions manifest file> has been updated`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Added ${results.length} extension(s):*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: extensionLinks.join('\n'),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Completed in ${parseMillisecondsIntoReadableTime(duration)}`,
          },
        ],
      },
    ];
  }
}

start();
