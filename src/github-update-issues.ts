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
    try {
      fs.unlinkSync(issuesReportFile);
    } catch (err) {
      // do nothing
    }
    const mapToGithubIssue = (rawIssue: any): IGithubIssue => {
      return {
        url: rawIssue.url,
        repository_url: rawIssue.repository_url,
        id: rawIssue.id,
        title: rawIssue.title,
        user: rawIssue.user,
        labels: rawIssue.labels.map((label: any) => ({
          id: label.id,
          node_id: label.node_id,
          url: label.url,
          name: label.name,
          color: label.color,
          default: label.default,
          description: label.description
        })),
        state: rawIssue.state,
        locked: rawIssue.locked,
        created_at: rawIssue.created_at,
        updated_at: rawIssue.updated_at,
        closed_at: rawIssue.closed_at,
        body: rawIssue.body,
        closed_by: rawIssue.closed_by,
        state_reason: rawIssue.state_reason,
        pull_request: rawIssue.pull_request ? {
          url: rawIssue.pull_request.url,
          html_url: rawIssue.pull_request.html_url,
          diff_url: rawIssue.pull_request.diff_url,
          patch_url: rawIssue.pull_request.patch_url
        } : undefined
      };
    }
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
        issues = response.data.reduce((acc: IGithubIssue[], issue: IGithubIssue) => {
          if (!issue || issue.pull_request || issue.title.toLowerCase().startsWith('review')) {
            return acc;
          }
          acc.push(mapToGithubIssue(issue));
          return acc;
        }, []);

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
