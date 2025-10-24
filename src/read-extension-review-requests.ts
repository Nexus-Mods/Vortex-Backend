import { Octokit } from 'octokit';
import dotenv from 'dotenv';

dotenv.config();

const ORG_REPO_NAME = "Nexus-Mods/Vortex";
const PROJECT_ID = 'PVT_kwDOAQS0W84AL03l'; // https://github.com/orgs/Nexus-Mods/projects/3
const EXTENSION_LABEL = 'extension';

// TypeScript interfaces for GitHub GraphQL responses
interface IProjectFieldValue {
  __typename: string;
  field: {
    name: string;
  };
  name?: string; // For SingleSelectFieldValue
}

interface IProjectItem {
  id: string;
  fieldValues: {
    nodes: IProjectFieldValue[];
  };
  content: {
    __typename: string;
    id: string;
    number: number;
    title: string;
    url: string;
    body: string;
    createdAt: string;
    updatedAt: string;
    author: {
      login: string;
    };
    labels: {
      nodes: Array<{
        name: string;
      }>;
    };
  };
}

interface IProjectItemsResponse {
  node: {
    items: {
      nodes: IProjectItem[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string;
      };
    };
  };
}

interface IReviewDetails {
  nexusUsername?: string;
  extensionModId?: string;
  extensionUrl?: string;
  gameDomain?: string;
  gameUrl?: string;
  existingExtensionUrl?: string;
}

interface IExtensionReviewRequest {
  issueNumber: number;
  title: string;
  url: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  labels: string[];
  projectItemId: string;
  reviewDetails: IReviewDetails;
}

function extractReviewDetails(body: string): IReviewDetails {
  const details: IReviewDetails = {};

  // Extract Nexus Username (### Nexus Username followed by the username on the next line)
  const usernameMatch = body.match(/###\s*Nexus\s+Username\s*\n+([^\n#]+)/i);
  if (usernameMatch) {
    details.nexusUsername = usernameMatch[1].trim();
  }

  // Extract Extension URL (### Extension URL followed by the URL on the next line)
  const extensionUrlMatch = body.match(/###\s*Extension\s+URL\s*\n+(https?:\/\/[^\s\n]+)/i);
  if (extensionUrlMatch) {
    details.extensionUrl = extensionUrlMatch[1].trim();
    // Extract the last segment (mod ID) from the URL
    const urlSegments = details.extensionUrl.split('/');
    const lastSegment = urlSegments[urlSegments.length - 1];
    if (lastSegment && /^\d+$/.test(lastSegment)) {
      details.extensionModId = lastSegment;
    }
  }

  // Extract Game URL (### Game URL followed by the URL on the next line)
  const gameUrlMatch = body.match(/###\s*Game\s+URL\s*\n+(https?:\/\/[^\s\n]+)/i);
  if (gameUrlMatch) {
    details.gameUrl = gameUrlMatch[1].trim();
    // Extract the last segment (game domain) from the URL
    const urlSegments = details.gameUrl.split('/');
    const lastSegment = urlSegments[urlSegments.length - 1];
    if (lastSegment) {
      details.gameDomain = lastSegment;
    }
  }

  // Extract Existing Extension URL (### Existing Extension URL followed by the URL on the next line)
  const existingExtensionMatch = body.match(/###\s*Existing\s+Extension\s+URL\s*\n+([^\n#]+)/i);
  if (existingExtensionMatch) {
    const existingUrl = existingExtensionMatch[1].trim();
    // Only set if it's not "NONE" or empty
    if (existingUrl && existingUrl.toUpperCase() !== 'NONE') {
      details.existingExtensionUrl = existingUrl;
    }
  }

  return details;
}

async function readExtensionReviewRequests(): Promise<IExtensionReviewRequest[]> {
  const octokit = new Octokit({ auth: process.env.PERSONAL_ACCESS_TOKEN });

  if (!process.env.PERSONAL_ACCESS_TOKEN) {
    throw new Error('PERSONAL_ACCESS_TOKEN environment variable is required');
  }

  console.log('Authenticating with GitHub...');
  const { data: { login } } = await octokit.rest.users.getAuthenticated();
  console.log(`Authenticated as: ${login}`);

  console.log(`Fetching issues from project: ${PROJECT_ID}`);

  const extensionRequests: IExtensionReviewRequest[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  // Paginate through all project items
  while (hasNextPage) {
    const response: IProjectItemsResponse = await octokit.graphql(
      `query ($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              nodes {
                id
                fieldValues(first: 20) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      field {
                        ... on ProjectV2SingleSelectField {
                          name
                        }
                      }
                      name
                    }
                  }
                }
                content {
                  __typename
                  ... on Issue {
                    id
                    number
                    title
                    url
                    body
                    createdAt
                    updatedAt
                    author {
                      login
                    }
                    labels(first: 10) {
                      nodes {
                        name
                      }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }`,
      {
        projectId: PROJECT_ID,
        cursor: cursor
      }
    );

    const items = response.node.items.nodes;

    // Filter items for issues with 'extension' label and 'Queued' status
    for (const item of items) {
      // Skip if not an issue
      if (item.content.__typename !== 'Issue') {
        continue;
      }

      // Check if issue has 'extension' label (allow for emoji suffixes like "extension :gear:")
      const hasExtensionLabel = item.content.labels.nodes.some(
        label => label.name.toLowerCase().startsWith(EXTENSION_LABEL.toLowerCase())
      );

      if (!hasExtensionLabel) {
        continue;
      }

      // Check if status is 'Queued'
      const statusField = item.fieldValues.nodes.find(
        (fieldValue: IProjectFieldValue) =>
          fieldValue.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
          fieldValue.field.name === 'Status'
      );

      const isQueued = statusField && 'name' in statusField &&
        statusField.name?.toLowerCase() === 'queued';

      if (!isQueued) {
        continue;
      }

      // Extract review details from the issue body
      const reviewDetails = extractReviewDetails(item.content.body);

      // Add to results
      extensionRequests.push({
        issueNumber: item.content.number,
        title: item.content.title,
        url: item.content.url,
        body: item.content.body,
        author: item.content.author.login,
        createdAt: item.content.createdAt,
        updatedAt: item.content.updatedAt,
        status: statusField?.name || 'Unknown',
        labels: item.content.labels.nodes.map(label => label.name),
        projectItemId: item.id,
        reviewDetails: reviewDetails
      });
    }

    // Check if there are more pages
    hasNextPage = response.node.items.pageInfo.hasNextPage;
    cursor = response.node.items.pageInfo.endCursor;
  }

  return extensionRequests;
}

async function main() {
  try {
    console.log('Starting to read extension review requests...\n');

    const requests = await readExtensionReviewRequests();

    console.log(`\nFound ${requests.length} extension review request(s) with "Queued" status:\n`);

    if (requests.length === 0) {
      console.log('No queued extension review requests found.');
      return;
    }

    // Display results
    requests.forEach((request, index) => {
      console.log(`${index + 1}. Issue #${request.issueNumber}: ${request.title}`);
      console.log(`URL: ${request.url}`);
      console.log(`Author: ${request.author}`);
      console.log(`Status: ${request.status}`);
      console.log(`Labels: ${request.labels.join(', ')}`);
      console.log(`Created: ${new Date(request.createdAt).toLocaleString()}`);
      console.log(`Updated: ${new Date(request.updatedAt).toLocaleString()}`);

      // Display review details if available
      if (request.reviewDetails) {
        console.log(`Review Details:`);
        if (request.reviewDetails.nexusUsername) {
          console.log(`Nexus Username: ${request.reviewDetails.nexusUsername}`);
        }
        if (request.reviewDetails.extensionModId) {
          console.log(`Extension Mod ID: ${request.reviewDetails.extensionModId}`);
        }
        if (request.reviewDetails.extensionUrl) {
          console.log(`Extension URL: ${request.reviewDetails.extensionUrl}`);
        }
        if (request.reviewDetails.gameDomain) {
          console.log(`Game Domain: ${request.reviewDetails.gameDomain}`);
        }
        if (request.reviewDetails.gameUrl) {
          console.log(`Game URL: ${request.reviewDetails.gameUrl}`);
        }
        if (request.reviewDetails.existingExtensionUrl) {
          console.log(`Existing Extension: ${request.reviewDetails.existingExtensionUrl}`);
        }
      }

      console.log('');
    });

    // Return the results for programmatic use
    return requests;
  } catch (error: any) {
    console.error('Error reading extension review requests:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Export functions and types for use in other modules
export { readExtensionReviewRequests, IExtensionReviewRequest, IReviewDetails };

// Run if executed directly
if (require.main === module) {
  main();
}
