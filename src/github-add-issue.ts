import { parse } from 'csv-parse';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { Octokit } from 'octokit';

dotenv.config();

const REPO_ID = 'R_kgDOBAT0mw'; // graphql id for github.com/Nexus-Mods/Vortex
const PROJECT_ID = 'PVT_kwDOAQS0W84AL03l'; // graphql id for https://github.com/orgs/Nexus-Mods/projects/3
const ISSUE_TEMPLATE_NAME = 'Verify Extension'; // labels will get pulled from here
const STATUS_FIELD_ID = "PVTSSF_lADOAQS0W84AL03lzgHitgU"; // graphql id for "Status" field in the project
const QUEUED_STATUS_VALUE_ID = "f75ad846"; // graphql id for "Queued" value in the "Status" field

function getTitle(name:string) {

  return `Verify Extension: ${name}`;
}

function getBody(name:string, id:string ) {

  const body = `# Verify Extension: ${name}

Use this template to verify game extensions for Vortex ​

## Extension Information

_Get all relevant metadata and links from nexusmods.com_ ​

|  |  |
|--|--|
| **Extension Name** | ${name} |
| **Extension Mod ID** | ${id} |
| **Extension URL** | https://www.nexusmods.com/site/mods/${id} |
| **Game Name** | |
| **Game Domain** |  |
| **Game URL** |  |

## Checked with

|  |  |
|--|--|
| **Extension Version** |  |
| **Vortex Version** |  |

## Instructions

TBC

## Verification checklist

- [ ] Is the extension named correctly?
- [ ] Is it packaged correctly?
- [ ] Is artwork correct?
- [ ] Is the changelog accurate?
- [ ] Does it install into Vortex?
- [ ] Does it correctly discover the game?
- [ ] Does it successfully install a mod?
- [ ] Does it successfully install a collection?
- [ ] Does the game run correctly with the mods installed? ​

## Adding extension to manifest

​ When complete, the verified extension needs adding to our manifest.

- [ ] GitHub Action run
- [ ] Manifest file manually checked for errors
- [ ] Contacted author
- [ ] Asked Community to enable Vortex for the game
- [ ] Discord [#vortex-announcements](https://discordapp.com/channels/215154001799413770/1141024162182336612) updated.
`;

  return body;
}



type CreateIssueResponse = {
  createIssue: {
    issue: {
      id: string;
      url: string;
      number: number;
    };
  };
};

type AddProjectV2ItemByIdResponse = {
  addProjectV2ItemById: {
    clientMutationId: string;
    item: {
      id: string;
      createdAt: string;
      creator: {
        url: string;
      };
    };
  };
};

//AddGithubProjectIssue('Test Extension', '123');

export default async function AddGithubProjectIssue(extensionName:string, extensionId:string) {

  // Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
  const octokit = new Octokit({ auth: process.env.PERSONAL_ACCESS_TOKEN });

  // Compare: https://docs.github.com/en/rest/reference/users#get-the-authenticated-user
  const {
    data: { login },
  } = await octokit.rest.users.getAuthenticated();

  console.log('Hello, %s', login);

  const issueTitle = getTitle(extensionName);
  const issueBody = getBody(extensionName, extensionId); 

  // create new issue
  // add issue to github project
  // change project item status 


  // create new issue

  const createIssueResponse:CreateIssueResponse = await octokit.graphql(
    `mutation ($repoId: ID!, $title: String!, $body: String!, $issueTemplate: String!) {
      createIssue(input: {repositoryId: $repoId, title: $title, body: $body, issueTemplate: $issueTemplate}) {
        issue {
          id
          url
          number
        }
      }
    }
      `,
      {
        repoId: REPO_ID,
        title: issueTitle,
        body: issueBody,
        issueTemplate: ISSUE_TEMPLATE_NAME
      }
  );

  console.log(createIssueResponse);

  // add new issue to project

  const addProjectV2ItemByIdResponse:AddProjectV2ItemByIdResponse = await octokit.graphql(
    `mutation ($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        clientMutationId
        item {
          id
          createdAt
          creator {
            url
          }
          
        }
      }
    }
      `,
      {
        projectId: PROJECT_ID,
        contentId: createIssueResponse.createIssue.issue.id
      }
  );

  console.log(addProjectV2ItemByIdResponse);

  // change project item status
  
  const updateProjectV2ItemFieldValueResponse = await octokit.graphql(
    `mutation ($projectId: ID!, $itemId: ID! $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value}) {
        clientMutationId				
      }
    }
      `,
      {
        projectId: PROJECT_ID,
        itemId: addProjectV2ItemByIdResponse.addProjectV2ItemById.item.id,
        fieldId: STATUS_FIELD_ID,
        value: {
          singleSelectOptionId: QUEUED_STATUS_VALUE_ID
        }
      }
  );

  console.log(updateProjectV2ItemFieldValueResponse);

  // move to top of column

  const updateProjectV2ItemPositionResponse = await octokit.graphql(
    `mutation ($projectId: ID!, $itemId: ID!) {
      updateProjectV2ItemPosition(input: { projectId: $projectId, itemId: $itemId}) {
        clientMutationId				
      }
    }
      `,
      {
        projectId: PROJECT_ID,
        itemId: addProjectV2ItemByIdResponse.addProjectV2ItemById.item.id
      }
  );

  console.log(updateProjectV2ItemPositionResponse);  
}
