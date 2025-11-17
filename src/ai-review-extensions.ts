import * as fs from 'fs-extra';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');
const DOWNLOADS_PATH: string = path.join(REPO_ROOT_PATH, 'review-downloads');
const REVIEW_REPORTS_PATH: string = path.join(REPO_ROOT_PATH, 'review-reports');
const AI_REVIEW_REPORTS_PATH: string = path.join(REPO_ROOT_PATH, 'ai-review-reports');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MAX_EXTENSIONS_TO_REVIEW = parseInt(process.env.MAX_AI_REVIEWS || '5', 10);

interface IAutomatedReview {
  modId: number;
  extensionName: string;
  findings: Array<{
    severity: 'critical' | 'warning' | 'info';
    category: string;
    description: string;
    file?: string;
    line?: number;
  }>;
  approved: boolean;
}

interface IAIReviewResult {
  modId: number;
  extensionName: string;
  aiAnalysis: string;
  securityAssessment: string;
  codeQualityAssessment: string;
  recommendations: string[];
  finalVerdict: 'APPROVE' | 'REJECT' | 'NEEDS_MANUAL_REVIEW';
  confidence: number;
  reasoning: string;
}

class AIExtensionReviewer {
  private anthropic: Anthropic;
  private aiReviews: IAIReviewResult[] = [];

  constructor(apiKey: string) {
    this.anthropic = new Anthropic({ apiKey });
  }

  public async reviewAll() {
    console.log('Starting AI-powered extension review using Claude...\n');

    if (!CLAUDE_API_KEY) {
      console.error('❌ CLAUDE_API_KEY or ANTHROPIC_API_KEY not found in environment');
      console.error('Please add it to your .env file');
      process.exit(1);
    }

    // Create AI reports directory
    await fs.mkdirp(AI_REVIEW_REPORTS_PATH);

    // Read automated review reports
    const reportFiles = (await fs.readdir(REVIEW_REPORTS_PATH))
      .filter(f => f.endsWith('-review.json') && !f.startsWith('summary'));

    console.log(`Found ${reportFiles.length} automated reviews`);
    console.log(`Will review up to ${MAX_EXTENSIONS_TO_REVIEW} extensions with AI\n`);

    const toReview = reportFiles.slice(0, MAX_EXTENSIONS_TO_REVIEW);

    for (const reportFile of toReview) {
      const reportPath = path.join(REVIEW_REPORTS_PATH, reportFile);
      const automatedReview: IAutomatedReview = JSON.parse(await fs.readFile(reportPath, 'utf-8'));

      console.log(`\n${'='.repeat(80)}`);
      console.log(`AI Reviewing: ${automatedReview.extensionName}`);
      console.log(`${'='.repeat(80)}`);

      try {
        const aiReview = await this.reviewExtensionWithAI(automatedReview);
        this.aiReviews.push(aiReview);

        // Save individual AI review
        await this.saveAIReview(aiReview);

        console.log(`\n✅ AI Review completed`);
        console.log(`Verdict: ${aiReview.finalVerdict} (Confidence: ${(aiReview.confidence * 100).toFixed(0)}%)`);
      } catch (err: any) {
        console.error(`❌ AI Review failed: ${err.message}`);
      }

      // Rate limiting: wait 1 second between requests
      if (toReview.indexOf(reportFile) < toReview.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Generate AI summary report
    await this.generateAISummaryReport();

    console.log(`\n${'='.repeat(80)}`);
    console.log('AI Review Summary');
    console.log(`${'='.repeat(80)}`);
    console.log(`Total AI reviews: ${this.aiReviews.length}`);
    console.log(`Approved: ${this.aiReviews.filter(r => r.finalVerdict === 'APPROVE').length}`);
    console.log(`Rejected: ${this.aiReviews.filter(r => r.finalVerdict === 'REJECT').length}`);
    console.log(`Needs Manual Review: ${this.aiReviews.filter(r => r.finalVerdict === 'NEEDS_MANUAL_REVIEW').length}`);
    console.log(`\nAI reports saved to: ${AI_REVIEW_REPORTS_PATH}`);
  }

  private async reviewExtensionWithAI(automatedReview: IAutomatedReview): Promise<IAIReviewResult> {
    // Gather extension code
    const extractedPath = path.join(
      DOWNLOADS_PATH,
      automatedReview.extensionName,
      'extracted'
    );

    const codeFiles = await this.gatherCodeFiles(extractedPath);

    // Build context for Claude
    const automatedFindings = this.formatAutomatedFindings(automatedReview);

    const prompt = `You are a senior security engineer and code reviewer for Vortex, a mod manager application. You are reviewing a Vortex extension for security vulnerabilities, code quality issues, and potential malicious behavior.

## Extension Information
**Name:** ${automatedReview.extensionName}
**Mod ID:** ${automatedReview.modId}

## Automated Scan Results
${automatedFindings}

## Extension Code
${codeFiles}

## Your Task
Please provide a comprehensive security and code quality review of this Vortex extension. Focus on:

1. **Security Assessment:**
   - Validate the automated findings
   - Look for additional security vulnerabilities (injection attacks, XSS, data exfiltration, etc.)
   - Check for suspicious patterns or obfuscated code
   - Assess risk level of any external API calls or network requests

2. **Code Quality Assessment:**
   - Evaluate code structure and organization
   - Check for proper error handling
   - Assess maintainability and best practices
   - Review extension metadata and configuration

3. **Malicious Behavior Detection:**
   - Look for data collection or transmission to external servers
   - Check for file system operations outside expected scope
   - Identify any attempts to execute arbitrary code
   - Review any process spawning or system commands

4. **Final Verdict:**
   Provide one of:
   - APPROVE: Extension is safe to publish
   - REJECT: Extension has critical security issues
   - NEEDS_MANUAL_REVIEW: Unclear or borderline cases requiring human review

Please format your response as follows:

**SECURITY ASSESSMENT:**
[Your detailed security assessment]

**CODE QUALITY ASSESSMENT:**
[Your detailed code quality assessment]

**RECOMMENDATIONS:**
- [Specific recommendation 1]
- [Specific recommendation 2]
[etc.]

**FINAL VERDICT:** [APPROVE/REJECT/NEEDS_MANUAL_REVIEW]

**CONFIDENCE:** [0.0-1.0]

**REASONING:**
[Brief explanation of your verdict]`;

    console.log('Sending to Claude API for analysis...');

    const message = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

    // Parse Claude's response
    const parsed = this.parseAIResponse(responseText);

    return {
      modId: automatedReview.modId,
      extensionName: automatedReview.extensionName,
      aiAnalysis: responseText,
      securityAssessment: parsed.securityAssessment,
      codeQualityAssessment: parsed.codeQualityAssessment,
      recommendations: parsed.recommendations,
      finalVerdict: parsed.finalVerdict,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    };
  }

  private formatAutomatedFindings(review: IAutomatedReview): string {
    if (review.findings.length === 0) {
      return '✅ No issues found by automated scanner';
    }

    const critical = review.findings.filter(f => f.severity === 'critical');
    const warnings = review.findings.filter(f => f.severity === 'warning');
    const info = review.findings.filter(f => f.severity === 'info');

    let output = '';

    if (critical.length > 0) {
      output += `\n### 🔴 Critical Issues (${critical.length}):\n`;
      critical.forEach(f => {
        output += `- **${f.category}:** ${f.description}`;
        if (f.file) output += ` (${f.file}${f.line ? `:${f.line}` : ''})`;
        output += '\n';
      });
    }

    if (warnings.length > 0) {
      output += `\n### ⚠️ Warnings (${warnings.length}):\n`;
      warnings.forEach(f => {
        output += `- **${f.category}:** ${f.description}`;
        if (f.file) output += ` (${f.file})`;
        output += '\n';
      });
    }

    if (info.length > 0) {
      output += `\n### ℹ️ Informational (${info.length}):\n`;
      info.forEach(f => {
        output += `- **${f.category}:** ${f.description}`;
        if (f.file) output += ` (${f.file})`;
        output += '\n';
      });
    }

    return output;
  }

  private async gatherCodeFiles(extractedPath: string): Promise<string> {
    const files: Array<{ path: string; content: string }> = [];

    try {
      await this.scanForCodeFiles(extractedPath, extractedPath, files);
    } catch (err: any) {
      return `Error reading extension files: ${err.message}`;
    }

    if (files.length === 0) {
      return 'No code files found';
    }

    // Limit total size to avoid token limits
    const maxSize = 50000; // ~50KB of code
    let totalSize = 0;
    let output = '';

    for (const file of files) {
      if (totalSize + file.content.length > maxSize) {
        output += `\n[... ${files.length - files.indexOf(file)} more files truncated due to size ...]\n`;
        break;
      }

      output += `\n### File: ${file.path}\n\`\`\`javascript\n${file.content}\n\`\`\`\n`;
      totalSize += file.content.length;
    }

    return output;
  }

  private async scanForCodeFiles(
    basePath: string,
    currentPath: string,
    files: Array<{ path: string; content: string }>
  ) {
    const items = await fs.readdir(currentPath);

    for (const item of items) {
      const fullPath = path.join(currentPath, item);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        if (item === 'node_modules') continue;
        await this.scanForCodeFiles(basePath, fullPath, files);
      } else {
        const ext = path.extname(fullPath).toLowerCase();
        if (['.js', '.ts', '.jsx', '.tsx', '.json'].includes(ext)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          const relativePath = path.relative(basePath, fullPath);
          files.push({ path: relativePath, content });
        }
      }
    }
  }

  private parseAIResponse(response: string): {
    securityAssessment: string;
    codeQualityAssessment: string;
    recommendations: string[];
    finalVerdict: 'APPROVE' | 'REJECT' | 'NEEDS_MANUAL_REVIEW';
    confidence: number;
    reasoning: string;
  } {
    const securityMatch = response.match(/\*\*SECURITY ASSESSMENT:\*\*([\s\S]*?)(?=\*\*CODE QUALITY ASSESSMENT:|\*\*RECOMMENDATIONS:|\*\*FINAL VERDICT:|$)/i);
    const codeQualityMatch = response.match(/\*\*CODE QUALITY ASSESSMENT:\*\*([\s\S]*?)(?=\*\*RECOMMENDATIONS:|\*\*FINAL VERDICT:|$)/i);
    const recommendationsMatch = response.match(/\*\*RECOMMENDATIONS:\*\*([\s\S]*?)(?=\*\*FINAL VERDICT:|$)/i);
    const verdictMatch = response.match(/\*\*FINAL VERDICT:\*\*\s*(APPROVE|REJECT|NEEDS_MANUAL_REVIEW)/i);
    const confidenceMatch = response.match(/\*\*CONFIDENCE:\*\*\s*([\d.]+)/i);
    const reasoningMatch = response.match(/\*\*REASONING:\*\*([\s\S]*?)$/i);

    const securityAssessment = securityMatch ? securityMatch[1].trim() : 'Not provided';
    const codeQualityAssessment = codeQualityMatch ? codeQualityMatch[1].trim() : 'Not provided';

    const recommendationsText = recommendationsMatch ? recommendationsMatch[1].trim() : '';
    const recommendations = recommendationsText
      .split('\n')
      .filter(line => line.trim().startsWith('-'))
      .map(line => line.replace(/^-\s*/, '').trim());

    const verdictText = verdictMatch ? verdictMatch[1].toUpperCase() : 'NEEDS_MANUAL_REVIEW';
    const finalVerdict = ['APPROVE', 'REJECT', 'NEEDS_MANUAL_REVIEW'].includes(verdictText)
      ? (verdictText as 'APPROVE' | 'REJECT' | 'NEEDS_MANUAL_REVIEW')
      : 'NEEDS_MANUAL_REVIEW';

    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : 'Not provided';

    return {
      securityAssessment,
      codeQualityAssessment,
      recommendations,
      finalVerdict,
      confidence,
      reasoning,
    };
  }

  private async saveAIReview(review: IAIReviewResult) {
    // Save JSON
    const jsonPath = path.join(AI_REVIEW_REPORTS_PATH, `${review.modId}-ai-review.json`);
    await fs.writeFile(jsonPath, JSON.stringify(review, null, 2));

    // Save Markdown
    const mdPath = path.join(AI_REVIEW_REPORTS_PATH, `${review.modId}-ai-review.md`);
    const md = this.generateMarkdownReport(review);
    await fs.writeFile(mdPath, md);
  }

  private generateMarkdownReport(review: IAIReviewResult): string {
    const verdictIcon = review.finalVerdict === 'APPROVE' ? '✅' : review.finalVerdict === 'REJECT' ? '❌' : '⚠️';

    let md = `# AI-Powered Extension Review\n\n`;
    md += `**Extension:** ${review.extensionName}\n`;
    md += `**Mod ID:** ${review.modId}\n`;
    md += `**Final Verdict:** ${verdictIcon} ${review.finalVerdict}\n`;
    md += `**Confidence:** ${(review.confidence * 100).toFixed(0)}%\n\n`;

    md += `## Security Assessment\n\n${review.securityAssessment}\n\n`;
    md += `## Code Quality Assessment\n\n${review.codeQualityAssessment}\n\n`;

    if (review.recommendations.length > 0) {
      md += `## Recommendations\n\n`;
      review.recommendations.forEach(rec => {
        md += `- ${rec}\n`;
      });
      md += `\n`;
    }

    md += `## Reasoning\n\n${review.reasoning}\n\n`;

    md += `---\n\n`;
    md += `*This review was generated by Claude AI (claude-sonnet-4)*\n`;

    return md;
  }

  private async generateAISummaryReport() {
    const summaryPath = path.join(AI_REVIEW_REPORTS_PATH, 'ai-summary.md');

    let md = `# AI-Powered Extension Review Summary\n\n`;
    md += `**Reviewed by:** Claude AI (claude-sonnet-4)\n`;
    md += `**Total Extensions:** ${this.aiReviews.length}\n`;
    md += `**Approved:** ${this.aiReviews.filter(r => r.finalVerdict === 'APPROVE').length}\n`;
    md += `**Rejected:** ${this.aiReviews.filter(r => r.finalVerdict === 'REJECT').length}\n`;
    md += `**Needs Manual Review:** ${this.aiReviews.filter(r => r.finalVerdict === 'NEEDS_MANUAL_REVIEW').length}\n\n`;

    md += `## Reviews\n\n`;
    md += `| Mod ID | Extension | Verdict | Confidence | Summary |\n`;
    md += `|--------|-----------|---------|------------|----------|\n`;

    this.aiReviews.forEach(review => {
      const icon = review.finalVerdict === 'APPROVE' ? '✅' : review.finalVerdict === 'REJECT' ? '❌' : '⚠️';
      const confidencePercent = (review.confidence * 100).toFixed(0);
      const summary = review.reasoning.substring(0, 100) + (review.reasoning.length > 100 ? '...' : '');
      md += `| ${review.modId} | ${review.extensionName} | ${icon} ${review.finalVerdict} | ${confidencePercent}% | ${summary} |\n`;
    });

    await fs.writeFile(summaryPath, md);
  }
}

async function start() {
  const reviewer = new AIExtensionReviewer(CLAUDE_API_KEY);
  await reviewer.reviewAll();
}

start().catch(err => {
  console.error('AI Review failed:', err);
  process.exit(1);
});
