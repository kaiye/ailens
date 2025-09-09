import * as fs from 'fs';
import * as path from 'path';
import { AICodeStorage } from '../../core/storage';

export class FileStatsService {
  constructor(private storage: AICodeStorage) {}

  async getDetailedFileStats(workspaceRoot?: string): Promise<Map<string, any>> {
    const allFileStats = this.storage.getAllFileStats();
    const detailedStats = new Map<string, any>();

    for (const [fileName, fileStats] of allFileStats.entries()) {
      const absolutePath = path.isAbsolute(fileName) ? fileName : path.join(process.cwd(), fileName);

      if (!workspaceRoot || !absolutePath.startsWith(workspaceRoot)) {
        continue;
      }

      // skip if file missing
      let fileExists = true;
      let lastModified = 0;
      try {
        const st = fs.statSync(absolutePath);
        lastModified = st.mtime.getTime();
      } catch {
        fileExists = false;
      }
      if (!fileExists) continue;

      let displayPath = absolutePath;
      if (workspaceRoot && absolutePath.startsWith(workspaceRoot)) {
        displayPath = path.relative(workspaceRoot, absolutePath);
      }

      // Read file to verify actual lines
      let actualTotalLines = 0;
      let actualAILines = 0;
      let actualTabLines = 0;
      let actualComposerLines = 0;

      try {
        const content = fs.readFileSync(absolutePath, 'utf8');
        const fileLines = content.split('\n');
        actualTotalLines = fileLines.length;

        for (const codeLine of fileStats.codeLines) {
          // Count only '+' operations as present lines
          if (codeLine.operation === '+') {
            if (this.findAILineInFile(fileLines, codeLine.content)) {
              actualAILines++;
              if (codeLine.source === 'tab') actualTabLines++;
              else if (codeLine.source === 'composer') actualComposerLines++;
            }
          }
        }
      } catch {
        // ignore unreadable
        continue;
      }

      const aiPercentage = actualTotalLines > 0 ? (actualAILines / actualTotalLines * 100) : 0;
      detailedStats.set(displayPath, {
        totalLines: actualTotalLines,
        aiLines: actualAILines,
        percentage: aiPercentage,
        tabLines: actualTabLines,
        composerLines: actualComposerLines,
        lastModified,
        storedAILines: fileStats.totalAILines,
        verificationStatus: actualTotalLines > 0 ? 'verified' : 'fallback'
      });
    }

    return detailedStats;
  }

  private findAILineInFile(fileLines: string[], aiContent: string): boolean {
    const trimmed = aiContent.trim();
    if (trimmed.length === 0) return false;

    // exact match
    if (fileLines.some(l => l.trim() === trimmed)) return true;

    // contains for longer tokens
    if (trimmed.length > 10 && fileLines.some(l => l.trim().includes(trimmed))) return true;

    // identifier match
    if (this.isIdentifierPattern(trimmed)) {
      const re = new RegExp(`\\\\b${this.escapeRegExp(trimmed)}\\\\b`);
      if (fileLines.some(l => re.test(l))) return true;
    }
    return false;
  }

  private isIdentifierPattern(content: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(content) && content.length > 2;
  }

  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

