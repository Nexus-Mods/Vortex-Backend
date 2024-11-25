import * as core from '@actions/core';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { IGithubIssue } from './types';
import { genHash } from './utils';

function extractErrorDetails(issue: IGithubIssue) {
  const report = issue.body;
  const messagePattern = /^#### Message\s+([\s\S]*?)^(?=####|$)/igm;
  const contextPattern = /^#### Context\s+```([\s\S]*?)```/igm;
  const stackPattern = /^#### Stack\s+```([\s\S]*?)```/igm;

  const messageMatch = report.match(messagePattern);
  const contextMatch = report.match(contextPattern);
  const stackMatch = report.match(stackPattern);

  const errorMessage = messageMatch ? messageMatch[0].replace(/^#### Message\s+/, '').trim() : '';
  const context = contextMatch ? contextMatch[0].replace(/^#### Context\s+```/, '').replace(/```$/, '').trim() : '';
  const stack = stackMatch ? stackMatch[0].replace(/^#### Stack\s+```/, '').replace(/```$/, '').trim() : '';

  return {
      errorMessage,
      context,
      stack
  };
}

function generateHash(issue: IGithubIssue) {
  return genHash(issue.body.slice(0, -30));
}


async function run() {
  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const repo = 'nexus-mods/vortex';
    const outputDir = path.resolve(__dirname, path.join('..', 'out'));
    const issuesReportFile = path.join(outputDir, 'issues_report.json');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const mapToGithubIssue = (rawIssue: any): IGithubIssue => {
      const hashRegex = new RegExp('hash: ([a-z0-9]+)', 'igm');
      const result = hashRegex.exec(rawIssue.body);
      const hash = result ? result[1] : null;
      if (hash === null) {
        core.info(`Hash not found in issue ${rawIssue.number}`);
      }
      return {
        ...rawIssue,
        hash: hash,
      };
    }
    const fetchIssues = async (state: string, since: string | null) => {
      let issues: IGithubIssue[] = [];
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const url = `https://api.github.com/repos/${repo}/issues?state=${state}&per_page=100&page=${page}${since ? `&since=${since}` : ''}`;
        const response = await axios.get(url, {
          headers: {
            Authorization: `${GITHUB_TOKEN}`
          }
        });

        issues = issues.concat(response.data.reduce((acc: IGithubIssue[], issue: IGithubIssue) => {
          if (!issue?.body || issue.pull_request || issue.title.toLowerCase().startsWith('review')) {
            return acc;
          }
          acc.push(mapToGithubIssue(issue));
          return acc;
        }, []));

        if (response.data.length < 100) {
          hasMorePages = false;
        } else {
          page++;
        }
      }
      return issues;
    };

    const openIssues = await fetchIssues('open', null);
    const lastMonthDate = new Date();
    lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
    const closedIssues = await fetchIssues('closed', lastMonthDate.toISOString());

    const issuesReport: IGithubIssue[] = [];

    const processIssues = (issues: IGithubIssue[]) => {
      for (const issue of issues) {;
        const author = issue.user.login;
        const hashMatch = /hash: ([a-z0-9]+)/gmi;
        if (author.toLowerCase() === 'vortexfeedback') {
          core.info(`Skipping issue by vortexfeedback: ${issue.number}`);
          continue;
        }
        if (!issue.hash && !hashMatch.test(issue.body)) {
          // No hash.
          continue;
        }
        
        const hash = issue.hash ?? hashMatch?.exec?.(issue.body)?.[1];
        issue.hash = hash
        issuesReport.push(issue);
        core.info(`Added issue by ${author}: ${issue.number}`);
      }
    };

    // Process both open and closed issues
    processIssues(openIssues);
    processIssues(closedIssues);

    try {
      // Remove the existing file
      fs.unlinkSync(issuesReportFile);
    } catch (err) {
      // do nothing
    }
    // Write issues report to JSON file
    fs.writeFileSync(issuesReportFile, JSON.stringify(issuesReport, null, 2));
    core.info(`Issues report written to ${issuesReportFile}`);
  } catch (error: any) {
    core.setFailed(error);
  }
}

run();
