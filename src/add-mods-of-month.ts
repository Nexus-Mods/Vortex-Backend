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
const EXT_MOTM_DATE = process.env.EXT_MOTM_DATE || '';

async function start() {

  console.log('Start Program');

  if (EXT_MOTM_LINK === '') {
    console.error('No EXT_MOTM_LINK found in env');
    process.exit(1);
  }

  if (EXT_MOTM_DATE !== '' && isNaN(+EXT_MOTM_DATE)) {
    console.error('EXT_MOTM_DATE is not a unix timestamp number');
    process.exit(1);
  }

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
    console.log('main env variables', { EXT_MOTM_LINK, EXT_MOTM_DATE });
    console.log('Processing MOTM...');
    this.mEntries = await this.readMOTMFile();
    const newEntry: IMOTMEntry = {
      date: !!EXT_MOTM_DATE ? +EXT_MOTM_DATE : Date.now(),
      id: nanoid.nanoid(),
      link: EXT_MOTM_LINK
    }
    const existingEntry = this.mEntries.find(e => e.link === newEntry.link);
    if (existingEntry) {
      console.log('Entry already exists, rejecting...');
      throw new Error('Entry already exists');
    }
    this.mEntries.push(newEntry);
    await this.writeMOTMFile(this.mEntries);
  }
}

start();
