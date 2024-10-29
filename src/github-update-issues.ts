import { IGithubIssue } from "./types";

const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const repo = 'nexus-mods/vortex';
    const outputDir = path.resolve(__dirname, path.join('..', 'out'));
    const issuesReportFile = path.join(outputDir, 'issues_report.json');

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const genIssue = (data: any): IGithubIssue => data as IGithubIssue;
    // Function to fetch issues with pagination support
    const fetchIssues = async (state: string, since: string | null) => {
      let issues: IGithubIssue[] = [];
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const url = `https://api.github.com/repos/${repo}/issues?state=${state}&per_page=100&page=${page}${since ? `&since=${since}` : ''}`;
        const response = await axios.get(url, {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`
          }
        });

        // Remove PRs
        issues = response.data.filter((issue: IGithubIssue) => !issue.pull_request && !issue.title.toLowerCase().startsWith('review'));
        issues = issues.map(genIssue);

        if (response.data.length < 100) {
          hasMorePages = false; // If fewer than 100 issues are returned, we're done
        } else {
          page++; // Otherwise, increment page number to fetch next page
        }
      }

      return issues;
    };

    // Fetch open and closed issues
    const openIssues = await fetchIssues('open', null);
    const lastMonthDate = new Date();
    lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
    const closedIssues = await fetchIssues('closed', lastMonthDate.toISOString());

    // Initialize the issues report
    const issuesReport: any[] = [];

    // Function to process issues
    const processIssues = (issues: any[]) => {
      for (const issue of issues) {
        const author = issue.user.login;
        if (author.toLowerCase() === 'vortexfeedback') {
          core.info(`Skipping issue by vortexfeedback: ${issue.number}`);
          continue;
        }
        issuesReport.push(issue);
      }
    };

    // Process both open and closed issues
    processIssues(openIssues);
    processIssues(closedIssues);

    // Write issues report to JSON file
    fs.writeFileSync(issuesReportFile, JSON.stringify(issuesReport, null, 2));
    core.info(`Issues report written to ${issuesReportFile}`);
  } catch (error) {
    core.setFailed(error);
  }
}

run();
