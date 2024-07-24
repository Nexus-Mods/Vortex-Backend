import { IMOTMEntry } from './types';
import * as fs from 'fs-extra';
import * as nanoid from 'nanoid';
import * as path from 'path';
import 'dotenv/config';
import { getFormattedDate } from './utils';

const MOTM_FILENAME = 'modsofthemonth.json';

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');

const MOTM_PATH: string = path.join(REPO_ROOT_PATH, 'out');
const MOTM_ARCHIVE_PATH: string = path.join(REPO_ROOT_PATH, 'archive');

// env variables
const EXT_MOTM_LINK = process.env.EXT_MOTM_LINK || '';
const EXT_MOTM_MONTH = process.env.EXT_MOTM_MONTH || '';
const EXT_MOTM_YEAR = process.env.EXT_MOTM_YEAR || '';

const MONTH_DICT: { [key: string]: number } = {
  'January': 1,
  'February': 2,
  'March': 3,
  'April': 4,
  'May': 5,
  'June': 6,
  'July': 7,
  'August': 8,
  'September': 9,
  'October': 10,
  'November': 11,
  'December': 12
}

async function start() {

  console.log('Start Program');

  [EXT_MOTM_LINK, EXT_MOTM_MONTH, EXT_MOTM_YEAR].forEach((envVar) => {
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

  private async readMOTMFile(): Promise<IMOTMEntry[]> {
    return JSON.parse(await fs.readFile(path.join(MOTM_PATH, MOTM_FILENAME), { encoding: 'utf8' }));
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

  private async writeMOTMFile(data: any) {
    // create folder just in case doesn't exist
    if (!fs.existsSync(MOTM_ARCHIVE_PATH)) {
      fs.mkdirSync(MOTM_ARCHIVE_PATH, { recursive: true });
    }

    // write an archive file too?
    await fs.writeFile(path.join(MOTM_ARCHIVE_PATH, `${getFormattedDate(new Date())}_${MOTM_FILENAME}`), JSON.stringify(data, undefined, 2), 'utf-8');

    // write the main file
    await fs.writeFile(path.join(MOTM_PATH, MOTM_FILENAME), JSON.stringify(data, undefined, 2), 'utf-8');
  }


  public async process() {
    console.log('main env variables', { EXT_MOTM_LINK, EXT_MOTM_MONTH, EXT_MOTM_YEAR });
    console.log('Processing MOTM...');
    this.mEntries = await this.readMOTMFile();
    const timestampMS = new Date(+EXT_MOTM_YEAR, MONTH_DICT[EXT_MOTM_MONTH]).getTime();
    const date = Math.floor(timestampMS / 1000);
    const newEntry: IMOTMEntry = {
      date,
      id: nanoid.nanoid(),
      videoid: this.extractVideoIdFromYouTubeUrl(EXT_MOTM_LINK)
    }
    const existingEntry = this.mEntries.find(e => e.videoid === newEntry.videoid);
    if (existingEntry) {
      console.log('Entry already exists, rejecting...');
      throw new Error('Entry already exists');
    }
    this.mEntries.push(newEntry);
    await this.writeMOTMFile(this.mEntries);
  }
}

start();
