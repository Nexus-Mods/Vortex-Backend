import { GAME_EMOJI, THEME_EMOJI, TRANSLATION_EMOJI, UNKNOWN_EMOJI } from './constants';
import { ExtensionType } from './types';

export function parseMillisecondsIntoReadableTime(duration: number) {
  //Get hours from milliseconds
  var hours = duration / (1000 * 60 * 60);
  var absoluteHours = Math.floor(hours);
  var h = absoluteHours > 9 ? absoluteHours : '0' + absoluteHours;

  //Get remainder from hours and convert to minutes
  var minutes = (hours - absoluteHours) * 60;
  var absoluteMinutes = Math.floor(minutes);
  var m = absoluteMinutes > 9 ? absoluteMinutes : '0' + absoluteMinutes;

  //Get remainder from minutes and convert to seconds
  var seconds = (minutes - absoluteMinutes) * 60;
  var absoluteSeconds = Math.floor(seconds);
  var s = absoluteSeconds > 9 ? absoluteSeconds : '0' + absoluteSeconds;

  return h + ':' + m + ':' + s;
}

export function getEmojiStringFromExtensionType(extensionType: ExtensionType | undefined): string {
  if (extensionType === undefined) return UNKNOWN_EMOJI;

  switch (extensionType) {
    case 'game':
      return GAME_EMOJI;
    case 'theme':
      return THEME_EMOJI;
    case 'translation':
      return TRANSLATION_EMOJI;
    default:
      return UNKNOWN_EMOJI;
  }
}

/**
 * Takes a date and returns it in YYYYMMDD_HHMM format
 * @param input date that needs formatting
 * @returns string formatted date
 */
export function getFormattedDate(date: Date): string {
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2);
  const day = ('0' + date.getDate()).slice(-2);

  const hours = ('0' + date.getHours()).slice(-2);
  const minutes = ('0' + date.getMinutes()).slice(-2);

  return `${year}${month}${day}_${hours}${minutes}`;
}
