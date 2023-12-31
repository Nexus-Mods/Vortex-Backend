import * as Slack from "@slack/bolt";
import 'dotenv/config';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '' ;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '' ; 

const WARNING_EMOJI = ':warning:';
const ERROR_EMOJI = ':x:';
const INFO_EMOJI = ':information_source:';

export default class SlackClient {

    private slack: any;
    private channelid: string;

    constructor(channelid:string) {
        
        if (SLACK_SIGNING_SECRET === '') {
            console.error('No SLACK_SIGNING_SECRET found in env');
            process.exit(1);
        }

        if (SLACK_BOT_TOKEN === '') {
            console.error('No SLACK_BOT_TOKEN found in env');
            process.exit(1);
        }
        
        this.channelid = channelid;

        this.slack = new Slack.App({
            token: SLACK_BOT_TOKEN,
            signingSecret: SLACK_SIGNING_SECRET,
        });  
    }

    public sendInfo(text: string) {

        const blocks = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${text}`
                }
            }
        ]

        this.postMessage(text, blocks);
    }
        
    public sendWarning(text: string) {

        const blocks = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${WARNING_EMOJI} ${text}`
                }
            }
        ]

        this.postMessage(text, blocks);
    }

    public sendError(text: string) {

        const blocks = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${ERROR_EMOJI} ${text}`
                }
            }
        ]

        this.postMessage(text, blocks);
    }

    public sendMessage(text: string, blocks: any[]) {
            
        this.postMessage(text, blocks);        
    }



    private postMessage(text: string, blocks: any[]) {

        this.slack.client.chat.postMessage({
            channel: this.channelid,
            text: text,
            blocks: blocks,
            unfurl_links: false
        })
    }

}