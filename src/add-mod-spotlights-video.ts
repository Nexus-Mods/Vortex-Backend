import { IMOTMEntry, ModSpotlightEntry, VideoEntryType } from './types';
import * as fs from 'fs-extra';
import * as nanoid from 'nanoid';
import * as path from 'path';
import 'dotenv/config';
import { getFormattedDate } from './utils';

/**
 * History lesson: this workflow was originally written to add the MOTM videos to the below JSON file.
 *  Even though we no longer add any entries to it, the file MUST NOT BE REMOVED to maintain integrity
 *  for users that are using Vortex 1.11.x - 1.12.x.
 * 
 * And yes I left this stale code here just to mention that.
 */
const DEPRECATED_MOTM_FILENAME = 'modsofthemonth.json';
const DEPRECATED_MONTH_DICT: { [key: string]: number } = {
  'January': 0,
  'February': 1,
  'March': 2,
  'April': 3,
  'May': 4,
  'June': 5,
  'July': 6,
  'August': 7,
  'September': 8,
  'October': 9,
  'November': 10,
  'December': 11
};

const MOD_SPOTLIGHTS_FILENAME = 'modspotlights.json';

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');

const OUT_PATH: string = path.join(REPO_ROOT_PATH, 'out');
const ARCHIVE_PATH: string = path.join(REPO_ROOT_PATH, 'archive');

// env variables
const EXT_LINK = process.env.EXT_LINK || '';

async function start() {

  console.log('Start Program');

  [EXT_LINK].forEach((envVar) => {
    if (envVar === '') {
      console.error(`No ${envVar} found in env`);
      process.exit(1);
    }
  });

  const driver = new Driver();
  await driver.process();
}

class Driver {
  private mEntries: IMOTMEntry[];

  constructor() {
    this.mEntries = [];
  }

  /**
   * 
   * @deprecated Use readSpotlightsFile() 
   */
  private async readMOTMFile(): Promise<IMOTMEntry[]> {
    return JSON.parse(await fs.readFile(path.join(OUT_PATH, DEPRECATED_MOTM_FILENAME), { encoding: 'utf8' }));
  }

  private async readSpotlightsFile(): Promise<ModSpotlightEntry[]> {
    return JSON.parse(await fs.readFile(path.join(OUT_PATH, MOD_SPOTLIGHTS_FILENAME), { encoding: 'utf8' }));
  }

  private async readAll(): Promise<ModSpotlightEntry[]> {
    return Promise.all([await this.readMOTMFile(), await this.readSpotlightsFile()].flat());
  }

  private extractVideoIdFromYouTubeUrl(url: string): string {
    let videoId: string;
    if (url.includes("watch?v=")) {
      videoId = url.split("watch?v=")[1].split("&")[0];
    } else {
      throw new Error('Invalid URL');
    }
    return videoId;
  }

  private async writeToFile(data: any, type: VideoEntryType) {
    // create folder just in case doesn't exist
    if (!fs.existsSync(ARCHIVE_PATH)) {
      fs.mkdirSync(ARCHIVE_PATH, { recursive: true });
    }

    // This should always resolve to modspotlights.json
    const fileName = (type === 'modsofthemonth') ? DEPRECATED_MOTM_FILENAME : MOD_SPOTLIGHTS_FILENAME;

    // write an archive file too?
    await fs.writeFile(path.join(ARCHIVE_PATH, `${getFormattedDate(new Date())}_${fileName}`), JSON.stringify(data, undefined, 2), 'utf-8');

    // write the main file
    await fs.writeFile(path.join(OUT_PATH, fileName), JSON.stringify(data, undefined, 2), 'utf-8');
  }

  public async process() {
    console.log('main env variables', { EXT_LINK });
    console.log('Processing Mod Spotlights...');
    this.mEntries = await this.readSpotlightsFile();
    const timestampMS = Date.now();
    const newEntry: ModSpotlightEntry = {
      date: timestampMS,
      id: nanoid.nanoid(),
      videoid: this.extractVideoIdFromYouTubeUrl(EXT_LINK)
    }
    const existingEntry = this.mEntries.find(e => e.videoid === newEntry.videoid);
    if (existingEntry) {
      console.log('Entry already exists, rejecting...');
      throw new Error('Entry already exists');
    }
    this.mEntries.push(newEntry);
    await this.writeToFile(this.mEntries, 'modspotlights');
  }
}

start();
