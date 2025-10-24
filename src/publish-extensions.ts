import { IAvailableExtension, IExtensionManifest } from './types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Octokit } from 'octokit';
import 'dotenv/config';
import SlackClient from './SlackClient';
import Stopwatch from '@tsdotnet/stopwatch';
import { getFormattedDate, parseMillisecondsIntoReadableTime } from './utils';
import { MANIFEST_FILENAME, SLACK_CHANNEL } from './constants';
import { readExtensionReviewRequests, IExtensionReviewRequest } from './read-extension-review-requests';
import { validateManifestEntry, normalizeManifestEntry } from './validate-manifest-entry';
import simpleGit, { SimpleGit } from 'simple-git';

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');
const MANIFEST_PATH: string = path.join(REPO_ROOT_PATH, 'out');
const MANIFEST_ARCHIVE_PATH: string = path.join(REPO_ROOT_PATH, 'archive');

const GITHUB_TOKEN = process.env.PERSONAL_ACCESS_TOKEN || '';
const GITHUB_REPO_OWNER = 'Nexus-Mods';
const GITHUB_REPO_NAME = 'Vortex';
const PROJECT_ID = 'PVT_kwDOAQS0W84AL03l';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const DRYRUN: boolean = (process.env.DRYRUN === 'true') || false;

// Only initialize Slack if credentials are available
let slack: SlackClient | null = null;
if (SLACK_SIGNING_SECRET && SLACK_BOT_TOKEN) {
  slack = new SlackClient(SLACK_CHANNEL);
} else {
  console.log('Slack credentials not found - notifications will be skipped\n');
}

interface IPublishResult {
  request: IExtensionReviewRequest;
  entry: IAvailableExtension;
  issueCommented: boolean;
  statusUpdated: boolean;
}

function exitWithError(message: string, context?: any): never {
  console.error(message, context || '');
  process.exit(1);
}

async function start() {
  console.log('Starting extension publishing workflow...\n');

  if (!GITHUB_TOKEN) {
    exitWithError('No PERSONAL_ACCESS_TOKEN found in env');
  }

  const publisher = new ExtensionPublisher(GITHUB_TOKEN);
  await publisher.publish();
}

class ExtensionPublisher {
  private manifest!: IExtensionManifest;
  private octokit: Octokit;
  private git: SimpleGit;

  constructor(githubToken: string) {
    this.octokit = new Octokit({ auth: githubToken });
    this.git = simpleGit(REPO_ROOT_PATH);
  }

  private async readManifestFile(): Promise<IExtensionManifest> {
    return JSON.parse(await fs.readFile(path.join(MANIFEST_PATH, MANIFEST_FILENAME), { encoding: 'utf8' }));
  }

  private async writeManifestFile(data: IExtensionManifest) {
    if (DRYRUN) {
      console.log('\n[DRY RUN] Would have written manifest file');
      console.log(`Total extensions: ${data.extensions.length}`);
      return;
    }

    // Create folder (recursive flag handles existence check)
    await fs.mkdirp(MANIFEST_ARCHIVE_PATH);

    // Write an archive file
    await fs.writeFile(
      path.join(MANIFEST_ARCHIVE_PATH, `${getFormattedDate(new Date())}_${MANIFEST_FILENAME}`),
      JSON.stringify(data, undefined, 2),
      'utf-8'
    );

    // Write the main file
    await fs.writeFile(
      path.join(MANIFEST_PATH, MANIFEST_FILENAME),
      JSON.stringify(data, undefined, 2),
      'utf-8'
    );

    console.log('Manifest file written successfully');
  }

  public async publish() {
    const stopwatch = Stopwatch.startNew();

    // Load current manifest
    this.manifest = await this.readManifestFile();
    console.log('Current manifest info:');
    console.log(`Last updated: ${new Date(this.manifest.last_updated).toString()}`);
    console.log(`Total extensions: ${this.manifest.extensions.length}\n`);

    // Read all queued review requests
    console.log('Fetching queued extension review requests from GitHub...\n');
    const requests = await readExtensionReviewRequests();

    if (requests.length === 0) {
      console.log('No queued extension review requests found. Nothing to publish.');
      return;
    }

    console.log(`Found ${requests.length} queued extension review request(s)\n`);

    // Collect entries to publish (extensions that exist in manifest with queued issues)
    const entriesToAdd: IAvailableExtension[] = [];
    const requestsToUpdate: IExtensionReviewRequest[] = [];

    for (const request of requests) {
      if (!request.reviewDetails.extensionModId) {
        console.log(`Skipping Issue #${request.issueNumber}: No extension mod ID found`);
        continue;
      }

      const modId = parseInt(request.reviewDetails.extensionModId, 10);

      // Check if it exists in manifest
      const entry = this.manifest.extensions.find(ext => ext.modId === modId);

      if (entry) {
        console.log(`Found entry for Issue #${request.issueNumber}: ${entry.name}`);

        // Validate and normalize
        const normalizedEntry = normalizeManifestEntry(entry);
        const validation = validateManifestEntry(normalizedEntry);

        if (validation.valid) {
          entriesToAdd.push(normalizedEntry);
          requestsToUpdate.push(request);
        } else {
          console.log(`Validation failed: ${validation.errors.join(', ')}`);
        }
      } else {
        console.log(`Warning: No manifest entry found for Issue #${request.issueNumber} (Mod ID: ${modId})`);
        console.log('Extensions should be validated and added via process-review-requests first.');
      }
    }

    if (entriesToAdd.length === 0) {
      console.log('\nNo valid extensions to publish.');
      return;
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('PUBLISHING EXTENSIONS');
    console.log(`${'='.repeat(80)}\n`);

    // Update manifest timestamp
    this.manifest.last_updated = Date.now();

    // Write updated manifest
    await this.writeManifestFile(this.manifest);

    // Commit and push changes
    if (!DRYRUN) {
      await this.commitAndPushChanges(entriesToAdd);
    } else {
      console.log('\n[DRY RUN] Would have committed and pushed changes');
    }

    // Process GitHub issues
    const publishResults: IPublishResult[] = [];
    for (let i = 0; i < requestsToUpdate.length; i++) {
      const request = requestsToUpdate[i];
      const entry = entriesToAdd[i];

      console.log(`\nProcessing Issue #${request.issueNumber}: ${request.title}`);

      const result: IPublishResult = {
        request,
        entry,
        issueCommented: false,
        statusUpdated: false,
      };

      // Add comment to issue
      if (!DRYRUN) {
        result.issueCommented = await this.commentOnIssue(request.issueNumber);
      } else {
        console.log(`[DRY RUN] Would have commented on issue #${request.issueNumber}`);
        result.issueCommented = true;
      }

      // Update issue status to Completed
      if (!DRYRUN) {
        result.statusUpdated = await this.updateIssueStatus(request.projectItemId, request.issueNumber);
      } else {
        console.log(`[DRY RUN] Would have updated status to Completed`);
        result.statusUpdated = true;
      }

      publishResults.push(result);
    }

    // Send Slack notification
    if (!DRYRUN && slack) {
      await this.sendSlackNotification(publishResults, stopwatch.elapsedMilliseconds);
    } else if (!DRYRUN) {
      console.log('\nSkipping Slack notification (no credentials)');
    } else {
      console.log('\n[DRY RUN] Would have sent Slack notification');
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(80)}\n`);
    console.log(`Successfully published: ${publishResults.length} extension(s)`);
    console.log(` - Manifest updated: `);
    console.log(` - Git committed: ${DRYRUN ? '[DRY RUN]' : ''}`);
    console.log(` - Issues commented: ${publishResults.filter(r => r.issueCommented).length}/${publishResults.length}`);
    console.log(` - Issues status updated: ${publishResults.filter(r => r.statusUpdated).length}/${publishResults.length}`);
    console.log(`\nCompleted in ${parseMillisecondsIntoReadableTime(stopwatch.elapsedMilliseconds)}`);
  }

  private async commitAndPushChanges(entries: IAvailableExtension[]): Promise<void> {
    try {
      console.log('\nCommitting changes to git...');

      // Configure git if needed
      await this.git.addConfig('user.name', 'Vortex Extension Publisher');
      await this.git.addConfig('user.email', 'noreply@nexusmods.com');

      // Stage the manifest files
      await this.git.add([
        path.join('out', MANIFEST_FILENAME),
        path.join('archive', `${getFormattedDate(new Date())}_${MANIFEST_FILENAME}`)
      ]);

      // Create commit message
      const extensionNames = entries.map(e => `- ${e.name}`).join('\n');
      const commitMessage = `Add ${entries.length} extension(s) to manifest ${extensionNames}`;

      // Commit
      await this.git.commit(commitMessage);
      console.log('Changes committed');

      // Push
      await this.git.push();
      console.log('Changes pushed to remote');

    } catch (error: any) {
      console.error('Error committing/pushing changes:', error.message);
      throw error;
    }
  }

  private async commentOnIssue(issueNumber: number): Promise<boolean> {
    try {
      await this.octokit.rest.issues.createComment({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        issue_number: issueNumber,
        body: 'Thank you for your contribution!',
      });

      console.log(`Commented on issue #${issueNumber}`);
      return true;
    } catch (error: any) {
      console.error(`Failed to comment on issue #${issueNumber}:`, error.message);
      return false;
    }
  }

  private async updateIssueStatus(projectItemId: string, issueNumber: number): Promise<boolean> {
    try {
      // First, get the project to find the status field ID
      const projectQuery = `
        query($projectId: ID!) {
          node(id: $projectId) {
            ... on ProjectV2 {
              fields(first: 20) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const projectResponse: any = await this.octokit.graphql(projectQuery, {
        projectId: PROJECT_ID,
      });

      // Find the Status field and the Completed option
      const statusField = projectResponse.node.fields.nodes.find(
        (field: any) => field.name === 'Status'
      );

      if (!statusField) {
        console.error(`Could not find Status field in project`);
        return false;
      }

      const completedOption = statusField.options.find(
        (option: any) => option.name === 'Completed'
      );

      if (!completedOption) {
        console.error(`Could not find Completed option in Status field`);
        return false;
      }

      // Update the project item status
      const updateMutation = `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $valueId: String!) {
          updateProjectV2ItemFieldValue(
            input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $valueId }
            }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `;

      await this.octokit.graphql(updateMutation, {
        projectId: PROJECT_ID,
        itemId: projectItemId,
        fieldId: statusField.id,
        valueId: completedOption.id,
      });

      console.log(`Updated issue #${issueNumber} status to Completed`);
      return true;
    } catch (error: any) {
      console.error(`Failed to update status for issue #${issueNumber}:`, error.message);
      return false;
    }
  }

  private async sendSlackNotification(results: IPublishResult[], duration: number) {
    if (!slack) {
      console.log('Slack client not initialized - skipping notification');
      return;
    }

    // Collect game URLs for extensions that need mod manager button enabled
    const gameUrls: string[] = [];
    const extensionLinks: string[] = [];

    for (const result of results) {
      const { entry, request } = result;

      // Add extension link
      extensionLinks.push(`" <https://www.nexusmods.com/site/mods/${entry.modId}|${entry.name}>`);

      // If it's a game extension with a game URL, add it
      if (entry.type === 'game' && request.reviewDetails.gameUrl) {
        gameUrls.push(request.reviewDetails.gameUrl);
      }
    }

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${results.length} extension(s) published to manifest*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: extensionLinks.join('\n'),
        },
      },
    ];

    // Add game URL section if there are any
    if (gameUrls.length > 0) {
      const gameUrlList = gameUrls.map(url => `" ${url}`).join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `@community, please enable the mod manager download button for the following games:\n${gameUrlList}`,
        },
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Completed in ${parseMillisecondsIntoReadableTime(duration)}`,
        },
      ],
    });

    slack.sendMessage('extension-publishing-summary', blocks);
    console.log('\nSlack notification sent');
  }
}

start();
