import { ExtensionType } from './types';

// static urls
export const LIVE_MANIFEST_URL:string = 'https://raw.githubusercontent.com/Nexus-Mods/Vortex-Backend/main/out/extensions-manifest.json';
export const DOWNLOAD_STATS_URL = 'https://staticstats.nexusmods.com/live_download_counts/mods/2295.csv';

// emojis for slack messages
export const GAME_EMOJI = ':joystick:';
export const THEME_EMOJI = ':art:';
export const TRANSLATION_EMOJI = ':earth_africa:';
export const UNKNOWN_EMOJI = ':question:';
export const TOOL_EMOJI = ':hammer_and_wrench:';

// time constants
export const ONE_DAY = 1000 * 60 * 60 * 24;

// slack constants
// this is dev-vortex. bot-test-slack = C06B8H5TGGG and bot-github-vortex = C05009EK5R6
export const SLACK_CHANNEL = 'C0GM4G264'; 

// files and paths
export const MANIFEST_FILENAME = 'extensions-manifest.json';

// nexus category to extension type mapping
export const CATEGORIES: { [id: number]: ExtensionType } = {
    4: 'game',
    7: 'translation',
    13: 'theme'
}

// site versioning constants
export const HTML_REGEX = new RegExp('&[lg]t;', 'g');
export const VERSION_MATCH_REGEX = new RegExp('^requires vortex ([><=-^~0-9\. ]*[0-9])', 'i');
export const htmlMap: { [entity: string]: string } = {
    '&gt;': '>',
    '&lt;': '<',
};

// excluded games
export const GAME_EXCLUSIONLIST = [
    'game-subnautica',
    'game-subnauticabelowzero',
];