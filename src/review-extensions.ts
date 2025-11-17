import * as fs from 'fs-extra';
import * as path from 'path';
import AdmZip = require('adm-zip');

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');
const DOWNLOADS_PATH: string = path.join(REPO_ROOT_PATH, 'review-downloads');
const REVIEW_REPORTS_PATH: string = path.join(REPO_ROOT_PATH, 'review-reports');

interface IExtensionReview {
  modId: number;
  extensionName: string;
  downloadPath: string;
  extractedPath?: string;
  findings: IReviewFinding[];
  summary: string;
  approved: boolean;
}

interface IReviewFinding {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  description: string;
  file?: string;
  line?: number;
}

class ExtensionReviewer {
  private reviews: IExtensionReview[] = [];

  public async reviewAll() {
    console.log('Starting automated extension review...\n');

    // Create reports directory
    await fs.mkdirp(REVIEW_REPORTS_PATH);

    // Find all downloaded extensions
    const folders = await fs.readdir(DOWNLOADS_PATH);

    for (const folder of folders) {
      const folderPath = path.join(DOWNLOADS_PATH, folder);
      const stat = await fs.stat(folderPath);

      if (stat.isDirectory()) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`Reviewing: ${folder}`);
        console.log(`${'='.repeat(80)}`);

        await this.reviewExtension(folderPath, folder);
      }
    }

    // Generate summary report
    await this.generateSummaryReport();

    console.log(`\n${'='.repeat(80)}`);
    console.log('Review Summary');
    console.log(`${'='.repeat(80)}`);
    console.log(`Total extensions reviewed: ${this.reviews.length}`);
    console.log(`Approved: ${this.reviews.filter(r => r.approved).length}`);
    console.log(`Rejected: ${this.reviews.filter(r => !r.approved).length}`);
    console.log(`\nReports saved to: ${REVIEW_REPORTS_PATH}`);
  }

  private async reviewExtension(folderPath: string, folderName: string) {
    const modId = parseInt(folderName.split('-')[0], 10);
    const files = await fs.readdir(folderPath);
    const zipFile = files.find(f => f.endsWith('.zip'));

    if (!zipFile) {
      console.log('No zip file found, skipping...');
      return;
    }

    const zipPath = path.join(folderPath, zipFile);
    const extractPath = path.join(folderPath, 'extracted');

    // Extract the zip file
    console.log(`Extracting ${zipFile}...`);
    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractPath, true);
      console.log('Extraction complete');
    } catch (err: any) {
      console.error(`Failed to extract: ${err.message}`);
      return;
    }

    // Perform automated checks
    const findings: IReviewFinding[] = [];
    await this.scanForSecurityIssues(extractPath, findings);
    await this.validateExtensionStructure(extractPath, findings);
    await this.checkCodeQuality(extractPath, findings);

    // Determine approval status
    const hasCritical = findings.some(f => f.severity === 'critical');
    const approved = !hasCritical;

    const review: IExtensionReview = {
      modId,
      extensionName: folderName,
      downloadPath: zipPath,
      extractedPath: extractPath,
      findings,
      summary: this.generateSummary(findings),
      approved,
    };

    this.reviews.push(review);

    // Save individual review report
    await this.saveReviewReport(review);

    // Display findings
    if (findings.length > 0) {
      console.log(`\nFindings (${findings.length}):`);
      findings.forEach(f => {
        const icon = f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '⚠️' : 'ℹ️';
        console.log(`${icon} [${f.severity.toUpperCase()}] ${f.category}: ${f.description}`);
        if (f.file) {
          console.log(`   File: ${f.file}${f.line ? `:${f.line}` : ''}`);
        }
      });
    } else {
      console.log('\n✅ No issues found');
    }

    console.log(`\nStatus: ${approved ? '✅ APPROVED' : '❌ REJECTED'}`);
  }

  private async scanForSecurityIssues(extractPath: string, findings: IReviewFinding[]) {
    await this.scanDirectory(extractPath, async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();

      // Only scan code files
      if (!['.js', '.ts', '.jsx', '.tsx', '.json'].includes(ext)) {
        return;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const relativePath = path.relative(extractPath, filePath);

      // Check for suspicious patterns
      const suspiciousPatterns = [
        { pattern: /eval\s*\(/gi, desc: 'Use of eval() detected', severity: 'critical' as const },
        { pattern: /child_process/gi, desc: 'Child process execution detected', severity: 'warning' as const },
        { pattern: /exec\s*\(/gi, desc: 'Use of exec() detected', severity: 'warning' as const },
        { pattern: /\.env/gi, desc: 'Reference to .env file', severity: 'info' as const },
        { pattern: /password|secret|token|api[_-]?key/gi, desc: 'Possible hardcoded credentials', severity: 'critical' as const },
        { pattern: /https?:\/\/[^\s"']+/gi, desc: 'External URL reference', severity: 'info' as const },
      ];

      for (const { pattern, desc, severity } of suspiciousPatterns) {
        const matches = content.match(pattern);
        if (matches) {
          // Check if it's actually hardcoded credentials
          if (desc.includes('credentials')) {
            const lines = content.split('\n');
            let foundHardcoded = false;
            lines.forEach((line, idx) => {
              if (pattern.test(line) && /[=:]\s*['"][^'"]+['"]/.test(line)) {
                foundHardcoded = true;
                findings.push({
                  severity,
                  category: 'Security',
                  description: desc,
                  file: relativePath,
                  line: idx + 1,
                });
              }
            });
            if (!foundHardcoded && matches.length > 0) {
              // Just references, not hardcoded
              findings.push({
                severity: 'info',
                category: 'Security',
                description: `${matches.length} reference(s) to sensitive keywords (not necessarily hardcoded)`,
                file: relativePath,
              });
            }
          } else {
            findings.push({
              severity,
              category: 'Security',
              description: `${desc} (${matches.length} occurrence(s))`,
              file: relativePath,
            });
          }
        }
      }
    });
  }

  private async validateExtensionStructure(extractPath: string, findings: IReviewFinding[]) {
    // Check for required files
    const requiredFiles = ['index.js', 'info.json'];

    for (const file of requiredFiles) {
      const exists = await this.fileExistsRecursive(extractPath, file);
      if (!exists) {
        findings.push({
          severity: 'critical',
          category: 'Structure',
          description: `Required file '${file}' not found`,
        });
      }
    }

    // Check info.json structure
    const infoJsonPath = await this.findFileRecursive(extractPath, 'info.json');
    if (infoJsonPath) {
      try {
        const infoJson = JSON.parse(await fs.readFile(infoJsonPath, 'utf-8'));

        const requiredFields = ['name', 'author', 'version', 'description'];
        for (const field of requiredFields) {
          if (!infoJson[field]) {
            findings.push({
              severity: 'warning',
              category: 'Structure',
              description: `info.json missing recommended field: '${field}'`,
              file: path.relative(extractPath, infoJsonPath),
            });
          }
        }
      } catch (err: any) {
        findings.push({
          severity: 'critical',
          category: 'Structure',
          description: `Invalid info.json: ${err.message}`,
          file: path.relative(extractPath, infoJsonPath),
        });
      }
    }
  }

  private async checkCodeQuality(extractPath: string, findings: IReviewFinding[]) {
    await this.scanDirectory(extractPath, async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();

      if (!['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
        return;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const relativePath = path.relative(extractPath, filePath);

      // Check for console.log (should use proper logging)
      const consoleMatches = content.match(/console\.(log|error|warn|debug)/g);
      if (consoleMatches && consoleMatches.length > 5) {
        findings.push({
          severity: 'info',
          category: 'Code Quality',
          description: `Excessive console statements (${consoleMatches.length} found)`,
          file: relativePath,
        });
      }

      // Check for TODO/FIXME comments
      const todoMatches = content.match(/\/\/\s*(TODO|FIXME|XXX|HACK)/gi);
      if (todoMatches) {
        findings.push({
          severity: 'info',
          category: 'Code Quality',
          description: `${todoMatches.length} TODO/FIXME comment(s) found`,
          file: relativePath,
        });
      }
    });
  }

  private async scanDirectory(dirPath: string, callback: (filePath: string) => Promise<void>) {
    const items = await fs.readdir(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        // Skip node_modules
        if (item === 'node_modules') continue;
        await this.scanDirectory(fullPath, callback);
      } else {
        await callback(fullPath);
      }
    }
  }

  private async fileExistsRecursive(dirPath: string, fileName: string): Promise<boolean> {
    const found = await this.findFileRecursive(dirPath, fileName);
    return found !== null;
  }

  private async findFileRecursive(dirPath: string, fileName: string): Promise<string | null> {
    const items = await fs.readdir(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        if (item === 'node_modules') continue;
        const found = await this.findFileRecursive(fullPath, fileName);
        if (found) return found;
      } else if (item === fileName) {
        return fullPath;
      }
    }

    return null;
  }

  private generateSummary(findings: IReviewFinding[]): string {
    const critical = findings.filter(f => f.severity === 'critical').length;
    const warnings = findings.filter(f => f.severity === 'warning').length;
    const info = findings.filter(f => f.severity === 'info').length;

    if (critical > 0) {
      return `🔴 CRITICAL ISSUES FOUND: ${critical} critical, ${warnings} warnings, ${info} info`;
    } else if (warnings > 0) {
      return `⚠️ WARNINGS FOUND: ${warnings} warnings, ${info} info`;
    } else if (info > 0) {
      return `ℹ️ INFORMATIONAL: ${info} info items`;
    } else {
      return '✅ NO ISSUES FOUND';
    }
  }

  private async saveReviewReport(review: IExtensionReview) {
    const reportPath = path.join(REVIEW_REPORTS_PATH, `${review.modId}-review.json`);
    await fs.writeFile(reportPath, JSON.stringify(review, null, 2));

    // Also create a readable markdown report
    const mdPath = path.join(REVIEW_REPORTS_PATH, `${review.modId}-review.md`);
    const md = this.generateMarkdownReport(review);
    await fs.writeFile(mdPath, md);
  }

  private generateMarkdownReport(review: IExtensionReview): string {
    let md = `# Extension Review Report\n\n`;
    md += `**Extension:** ${review.extensionName}\n`;
    md += `**Mod ID:** ${review.modId}\n`;
    md += `**Status:** ${review.approved ? '✅ APPROVED' : '❌ REJECTED'}\n`;
    md += `**Summary:** ${review.summary}\n\n`;

    if (review.findings.length > 0) {
      md += `## Findings\n\n`;

      const critical = review.findings.filter(f => f.severity === 'critical');
      const warnings = review.findings.filter(f => f.severity === 'warning');
      const info = review.findings.filter(f => f.severity === 'info');

      if (critical.length > 0) {
        md += `### 🔴 Critical Issues (${critical.length})\n\n`;
        critical.forEach(f => {
          md += `- **${f.category}:** ${f.description}\n`;
          if (f.file) md += `  - File: \`${f.file}\`${f.line ? ` (line ${f.line})` : ''}\n`;
        });
        md += `\n`;
      }

      if (warnings.length > 0) {
        md += `### ⚠️ Warnings (${warnings.length})\n\n`;
        warnings.forEach(f => {
          md += `- **${f.category}:** ${f.description}\n`;
          if (f.file) md += `  - File: \`${f.file}\`${f.line ? ` (line ${f.line})` : ''}\n`;
        });
        md += `\n`;
      }

      if (info.length > 0) {
        md += `### ℹ️ Informational (${info.length})\n\n`;
        info.forEach(f => {
          md += `- **${f.category}:** ${f.description}\n`;
          if (f.file) md += `  - File: \`${f.file}\`${f.line ? ` (line ${f.line})` : ''}\n`;
        });
      }
    } else {
      md += `## ✅ No Issues Found\n\n`;
      md += `This extension passed all automated checks.\n`;
    }

    return md;
  }

  private async generateSummaryReport() {
    const summaryPath = path.join(REVIEW_REPORTS_PATH, 'summary.md');

    let md = `# Extension Review Summary\n\n`;
    md += `**Total Extensions:** ${this.reviews.length}\n`;
    md += `**Approved:** ${this.reviews.filter(r => r.approved).length}\n`;
    md += `**Rejected:** ${this.reviews.filter(r => !r.approved).length}\n\n`;

    md += `## Extensions\n\n`;
    md += `| Mod ID | Extension | Status | Summary |\n`;
    md += `|--------|-----------|--------|----------|\n`;

    this.reviews.forEach(review => {
      const status = review.approved ? '✅' : '❌';
      md += `| ${review.modId} | ${review.extensionName} | ${status} | ${review.summary} |\n`;
    });

    await fs.writeFile(summaryPath, md);
  }
}

async function start() {
  const reviewer = new ExtensionReviewer();
  await reviewer.reviewAll();
}

start().catch(err => {
  console.error('Review failed:', err);
  process.exit(1);
});
