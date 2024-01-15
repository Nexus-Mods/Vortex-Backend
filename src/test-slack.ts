import * as Slack from '@slack/bolt';
import 'dotenv/config';
import { ExtensionType } from './types';
import SlackClient from './SlackClient';
import Stopwatch from "@tsdotnet/stopwatch";
import { parseMillisecondsIntoReadableTime } from './utils';

const SLACK_CHANNEL = 'C06B8H5TGGG'; // actual channel id C05009EK5R6

const GAME_ICON = ':joystick:';
const THEME_ICON = ':art:';
const TRANSLATION_ICON = ':earth_africa:';
const UNKNOWN_ICON = ':question:';
const TOOL_EMOJI = ':hammer_and_wrench:';

const slack = new SlackClient(SLACK_CHANNEL);

const stopwatch = Stopwatch.startNew();

async function postMessage() {

  
  // :joystick: <https://google.com|DELTARUNE Vortex Extension> - 1.0.3

  const addedExtensions: any[] = [
    
  ];

  const updatedExtensions: any[] = [
    getEmojiStringFromExtensionType('game') + ' <https://google.com|DELTARUNE Vortex Extension> - 1.0.3',
    getEmojiStringFromExtensionType('theme') + ' <https://google.com|Visual Assist Night - Vortex Theme> - 3.4',
    getEmojiStringFromExtensionType('translation') + ' <https://google.com|Russian localization for Vortex> - 1.9.10',
    getEmojiStringFromExtensionType(null) + ' <https://google.com|Test tool> - 1.2.3',
    getEmojiStringFromExtensionType(undefined) + ' <https://google.com|Undefined test> - 1.2.3',
  ];

  const blocks = buildSlackBlocks(addedExtensions, updatedExtensions);  

  slack.sendMessage('This is text', blocks);
}

function getEmojiStringFromExtensionType(extensionType: ExtensionType | undefined): string {
  switch (extensionType) {
    case 'game':
      return GAME_ICON;
    case 'theme':
      return THEME_ICON;
    case 'translation':
      return TRANSLATION_ICON;
    case null:
          return TOOL_EMOJI;
    default:
      return UNKNOWN_ICON;
  }
}

function buildSlackBlocks(addedExtensions: string[], updatedExtensions: string[]): any[] {

  const headerBlock: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '<https://google.com|Extensions manifest> has been updated',
      },
    },
  ];

  const footerBlock: any[] = [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Completed in ${parseMillisecondsIntoReadableTime(stopwatch.elapsedMilliseconds)}`,
        },
      ],
    },
  ];

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
        text: addedExtensions.join('\n'),
      },
    },
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
        text: updatedExtensions.join('\n'),
      },
    },
  ];

  let blocks = [...headerBlock];
  if (addedExtensions.length > 0) blocks = blocks.concat(addedExtensionsBlock);
  if (updatedExtensions.length > 0) blocks = blocks.concat(updatedExtensionsBlock);
  blocks = blocks.concat(footerBlock);

  return blocks;
}

postMessage();
