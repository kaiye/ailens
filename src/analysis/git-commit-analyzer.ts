import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { 
  GitCommitAnalysis, 
  CommitInfo, 
  FileChange, 
  DiffLine, 
  AIMatchResult,
  CommitAnalysisCache,
  CachedCommitAnalysis
} from '../core/types';
import { AICodeStorage } from '../core/storage';

const execAsync = promisify(exec);

/**
 * Git 提交分析器
 * 分析最近的git提交中AI代码的贡献度
 */
export class GitCommitAnalyzer {
  private cacheDir: string;
  private cacheFile: string;
  private cache: CommitAnalysisCache = {};
  private readonly MAX_TIME_WINDOW = 7 * 24 * 60 * 60 * 1000; // 7天时间窗口

  constructor(private aiCodeStorage: AICodeStorage) {
    this.cacheDir = path.join(os.homedir(), '.ailens');
    this.cacheFile = path.join(this.cacheDir, 'git-commit-analysis.json');
    this.loadCache();
  }

  /**
   * 分析最近的提交（主要入口方法）
   */
  async analyzeRecentCommits(workspaceRoot: string, count: number = 3): Promise<GitCommitAnalysis> {
    try {
      console.log(`📊 [GIT_ANALYZER] Starting analysis for ${count} recent commits`);
      
      // 获取当前分支和提交列表
      const currentBranch = await this.getCurrentBranch(workspaceRoot);
      const recentHashes = await this.getRecentCommitHashes(workspaceRoot, count);
      
      console.log(`📊 [GIT_ANALYZER] Found ${recentHashes.length} recent commits on branch: ${currentBranch}`);
      
      // 分析每个提交
      const analysisResults: CommitInfo[] = [];
      
      // 首先分析未提交的更改
      const uncommittedAnalysis = await this.analyzeUncommittedChanges(workspaceRoot);
      if (uncommittedAnalysis) {
        analysisResults.push(uncommittedAnalysis);
      }
      
      for (const hash of recentHashes) {
        const analysis = await this.analyzeCommit(workspaceRoot, hash);
        if (analysis) {
          analysisResults.push(analysis);
        }
      }
      
      const result: GitCommitAnalysis = {
        currentBranch,
        recentCommits: analysisResults,
        lastAnalyzedAt: Date.now()
      };
      
      console.log(`📊 [GIT_ANALYZER] Analysis complete: ${analysisResults.length} commits analyzed`);
      return result;
      
    } catch (error) {
      console.error('❌ [GIT_ANALYZER] Analysis failed:', error);
      return {
        currentBranch: 'unknown',
        recentCommits: [],
        lastAnalyzedAt: Date.now()
      };
    }
  }

  /**
   * 分析未提交的更改
   */
  private async analyzeUncommittedChanges(workspaceRoot: string): Promise<CommitInfo | null> {
    try {
      console.log(`📊 [GIT_ANALYZER] Analyzing uncommitted changes`);
      
      // 检查是否有未提交的更改
      const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: workspaceRoot });
      
      if (!statusOutput.trim()) {
        console.log(`📊 [GIT_ANALYZER] No uncommitted changes found`);
        return null; // 没有未提交的更改
      }
      
      // 分析git diff获取实际的变更统计
      const diffAnalysis = await this.analyzeUncommittedDiff(workspaceRoot);
      
      // 获取最新AI项目的时间作为参考
      const latestAITimestamp = this.getLatestAITimestamp();
      
      return {
        hash: 'uncommitted',
        shortHash: 'uncommitted',
        author: '-',
        date: new Date(latestAITimestamp).toISOString(),
        timestamp: latestAITimestamp,
        message: '-',
        totalFiles: diffAnalysis.totalFiles,
        totalAdditions: diffAnalysis.totalAdditions,
        totalDeletions: diffAnalysis.totalDeletions,
        aiAdditions: diffAnalysis.aiAdditions,
        aiDeletions: diffAnalysis.aiDeletions,
        aiContributionPercentage: diffAnalysis.aiContributionPercentage,
        files: diffAnalysis.files
      };
      
    } catch (error) {
      console.error('❌ [GIT_ANALYZER] Failed to analyze uncommitted changes:', error);
      return null;
    }
  }

  /**
   * 分析未提交的diff变更 - 使用更稳定的方法
   */
  private async analyzeUncommittedDiff(workspaceRoot: string): Promise<{
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
    aiAdditions: number;
    aiDeletions: number;
    aiContributionPercentage: number;
    files: FileChange[];
  }> {
    let totalFiles = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;
    let aiAdditions = 0;
    let aiDeletions = 0;
    const files: FileChange[] = [];

    try {
      // 获取工作区变更（未暂存的）
      const { stdout: workingTreeStats } = await execAsync('git diff --numstat', { cwd: workspaceRoot });
      
      // 获取暂存区变更（已暂存的）
      const { stdout: stagedStats } = await execAsync('git diff --cached --numstat', { cwd: workspaceRoot });
      
      // 获取未跟踪文件
      const { stdout: untrackedOutput } = await execAsync('git ls-files --others --exclude-standard', { cwd: workspaceRoot });
      
      // 处理未跟踪文件
      if (untrackedOutput.trim()) {
        const untrackedFiles = untrackedOutput.trim().split('\n');
        for (const filePath of untrackedFiles) {
          if (!filePath.trim()) continue;
          
          const absolutePath = path.join(workspaceRoot, filePath);
          const additionCount = await this.countFileLines(absolutePath);
          
          if (additionCount > 0) {
            totalFiles++;
            totalAdditions += additionCount;
            
            const aiCount = await this.countAILinesInFile(absolutePath, '+');
            aiAdditions += aiCount;
          }
        }
      }
      
      // 处理已跟踪文件的变更（工作区 + 暂存区）
      const allStats = (workingTreeStats + '\n' + stagedStats).trim();
      if (allStats) {
        const statsLines = allStats.split('\n').filter(line => line.trim());
        const processedFiles = new Set<string>(); // 避免重复处理同一文件
        
        for (const statsLine of statsLines) {
          if (!statsLine.trim()) continue;
          
          // git diff --numstat format: additions deletions filename
          const parts = statsLine.split('\t');
          if (parts.length !== 3) continue;
          
          const [additionsStr, deletionsStr, filePath] = parts;
          const additions = additionsStr === '-' ? 0 : parseInt(additionsStr, 10) || 0;
          const deletions = deletionsStr === '-' ? 0 : parseInt(deletionsStr, 10) || 0;
          
          if (processedFiles.has(filePath)) {
            continue;
          }
          processedFiles.add(filePath);
          
          if (additions > 0 || deletions > 0) {
            totalFiles++;
            totalAdditions += additions;
            totalDeletions += deletions;
            
            // 获取具体的diff内容来分析AI行
            try {
              const { stdout: diffOutput } = await execAsync(`git diff HEAD -- "${filePath}"`, { cwd: workspaceRoot });
              if (diffOutput.trim()) {
                const { addedLines, deletedLines } = this.parseDiffLines(diffOutput, filePath, Date.now());
                const aiAdditionsInFile = addedLines.filter(line => line.isAIGenerated).length;
                const aiDeletionsInFile = deletedLines.filter(line => line.isAIGenerated).length;
                
                aiAdditions += aiAdditionsInFile;
                aiDeletions += aiDeletionsInFile;
                
                files.push({
                  filename: filePath,
                  additions: additions,
                  deletions: deletions,
                  aiAdditions: aiAdditionsInFile,
                  aiDeletions: aiDeletionsInFile,
                  addedLines: addedLines,
                  deletedLines: deletedLines
                });
              }
            } catch (diffError) {
              // 如果无法获取diff，至少记录文件变更统计
              files.push({
                filename: filePath,
                additions: additions,
                deletions: deletions,
                aiAdditions: 0,
                aiDeletions: 0,
                addedLines: [],
                deletedLines: []
              });
            }
          }
        }
      }

      const totalChanges = totalAdditions + totalDeletions;
      const totalAIChanges = aiAdditions + aiDeletions;
      const aiContributionPercentage = totalChanges > 0 ? (totalAIChanges / totalChanges * 100) : 0;

      console.log(`📊 [GIT_ANALYZER] Uncommitted diff analysis: ${totalFiles} files, +${totalAdditions}/-${totalDeletions}, AI: +${aiAdditions}/-${aiDeletions} (${aiContributionPercentage.toFixed(1)}%)`);

      return {
        totalFiles,
        totalAdditions,
        totalDeletions,
        aiAdditions,
        aiDeletions,
        aiContributionPercentage,
        files
      };

    } catch (error) {
      console.error('❌ [GIT_ANALYZER] Failed to analyze uncommitted diff:', error);
      return {
        totalFiles: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        aiAdditions: 0,
        aiDeletions: 0,
        aiContributionPercentage: 0,
        files: []
      };
    }
  }

  /**
   * 计算文件行数（用于未跟踪文件）
   */
  private async countFileLines(filePath: string): Promise<number> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      return content.split('\n').length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * 计算文件中AI代码行数
   */
  private async countAILinesInFile(filePath: string, operation: '+' | '-'): Promise<number> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const lines = content.split('\n');
      let aiCount = 0;

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const matchResult = this.matchLineToAI(line.trim(), operation, filePath, Date.now());
        if (matchResult.matched) {
          aiCount++;
        }
      }

      return aiCount;
    } catch (error) {
      return 0;
    }
  }

  /**
   * 获取最新AI项目的时间戳
   */
  private getLatestAITimestamp(): number {
    const allFileStats = this.aiCodeStorage.getAllFileStats();
    let latestTimestamp = 0;
    
    for (const [_, fileStats] of allFileStats) {
      for (const codeLine of fileStats.codeLines) {
        if (codeLine.timestamp > latestTimestamp) {
          latestTimestamp = codeLine.timestamp;
        }
      }
    }
    
    return latestTimestamp || Date.now();
  }

  /**
   * 分析单个提交
   */
  private async analyzeCommit(workspaceRoot: string, hash: string): Promise<CommitInfo | null> {
    try {
      // 检查缓存
      if (this.isCacheValid(hash)) {
        console.log(`📊 [GIT_ANALYZER] Using cached analysis for ${hash.substring(0, 8)}`);
        return this.cache[hash].analysis;
      }
      
      console.log(`📊 [GIT_ANALYZER] Analyzing commit ${hash.substring(0, 8)}`);
      
      // 获取提交基本信息
      const commitInfo = await this.getCommitInfo(workspaceRoot, hash);
      if (!commitInfo) {
        return null;
      }
      
      // 获取提交的文件变更
      const fileChanges = await this.analyzeCommitChanges(workspaceRoot, hash, commitInfo.timestamp || 0);
      
      // 计算AI贡献统计
      const aiStats = this.calculateAIContribution(fileChanges);
      
      const analysis: CommitInfo = {
        hash: commitInfo.hash || hash,
        shortHash: commitInfo.shortHash || hash.substring(0, 8),
        author: commitInfo.author || 'Unknown',
        date: commitInfo.date || new Date().toISOString(),
        timestamp: commitInfo.timestamp || Date.now(),
        message: commitInfo.message || 'No message',
        ...aiStats,
        files: fileChanges
      };
      
      // 缓存结果
      this.cacheAnalysis(hash, analysis);
      
      console.log(`📊 [GIT_ANALYZER] Commit ${hash.substring(0, 8)}: ${aiStats.aiAdditions}+/${aiStats.aiDeletions}- AI lines (${aiStats.aiContributionPercentage.toFixed(1)}%)`);
      
      return analysis;
      
    } catch (error) {
      console.error(`❌ [GIT_ANALYZER] Failed to analyze commit ${hash}:`, error);
      return null;
    }
  }

  /**
   * 获取当前Git分支
   */
  private async getCurrentBranch(workspaceRoot: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git branch --show-current', { cwd: workspaceRoot });
      return stdout.trim() || 'unknown';
    } catch (error) {
      console.error('Failed to get current branch:', error);
      return 'unknown';
    }
  }

  /**
   * 获取最近的提交哈希列表
   */
  private async getRecentCommitHashes(workspaceRoot: string, count: number): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`git log -${count} --pretty=format:"%H"`, { cwd: workspaceRoot });
      return stdout.trim().split('\n').filter(hash => hash.length > 0);
    } catch (error) {
      console.error('Failed to get recent commit hashes:', error);
      return [];
    }
  }

  /**
   * 获取提交基本信息
   */
  private async getCommitInfo(workspaceRoot: string, hash: string): Promise<Partial<CommitInfo> | null> {
    try {
      const { stdout } = await execAsync(`git show --pretty=format:"%H|%h|%an|%ad|%at|%s" --no-patch "${hash}"`, { 
        cwd: workspaceRoot 
      });
      
      const parts = stdout.trim().split('|');
      if (parts.length < 6) {
        return null;
      }
      
      return {
        hash: parts[0],
        shortHash: parts[1],
        author: parts[2],
        date: parts[3],
        timestamp: parseInt(parts[4]) * 1000, // 转换为毫秒
        message: parts[5]
      };
      
    } catch (error) {
      console.error(`Failed to get commit info for ${hash}:`, error);
      return null;
    }
  }

  /**
   * 分析提交的文件变更
   */
  private async analyzeCommitChanges(workspaceRoot: string, hash: string, commitTimestamp: number): Promise<FileChange[]> {
    try {
      // 获取文件级统计信息
      const fileStats = await this.getCommitFileStats(workspaceRoot, hash);
      
      // 获取详细的diff信息
      const diffContent = await this.getCommitDiff(workspaceRoot, hash);
      
      // 解析diff并匹配AI内容
      const fileChanges: FileChange[] = [];
      
      for (const fileStat of fileStats) {
        const fileChange = await this.analyzeFileChange(
          fileStat.filename,
          fileStat.additions,
          fileStat.deletions,
          diffContent,
          commitTimestamp
        );
        
        if (fileChange) {
          fileChanges.push(fileChange);
        }
      }
      
      return fileChanges;
      
    } catch (error) {
      console.error(`Failed to analyze commit changes for ${hash}:`, error);
      return [];
    }
  }

  /**
   * 获取提交的文件统计信息
   */
  private async getCommitFileStats(workspaceRoot: string, hash: string): Promise<Array<{filename: string, additions: number, deletions: number}>> {
    try {
      const { stdout } = await execAsync(`git show --numstat "${hash}"`, { cwd: workspaceRoot });
      
      const lines = stdout.trim().split('\n');
      const fileStats: Array<{filename: string, additions: number, deletions: number}> = [];
      
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const additions = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
          const deletions = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
          const filename = parts[2];
          
          // 跳过二进制文件和非代码文件
          if (this.isCodeFile(filename)) {
            fileStats.push({ filename, additions, deletions });
          }
        }
      }
      
      return fileStats;
      
    } catch (error) {
      console.error('Failed to get commit file stats:', error);
      return [];
    }
  }

  /**
   * 获取提交的详细diff内容
   */
  private async getCommitDiff(workspaceRoot: string, hash: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git show --unified=1 "${hash}"`, { cwd: workspaceRoot });
      return stdout;
    } catch (error) {
      console.error('Failed to get commit diff:', error);
      return '';
    }
  }

  /**
   * 分析单个文件的变更
   */
  private async analyzeFileChange(
    filename: string,
    totalAdditions: number,
    totalDeletions: number,
    diffContent: string,
    commitTimestamp: number
  ): Promise<FileChange | null> {
    
    // 解析该文件的diff部分
    const fileDiff = this.extractFileDiff(diffContent, filename);
    if (!fileDiff) {
      return null;
    }
    
    // 解析添加和删除的行
    const { addedLines, deletedLines } = this.parseDiffLines(fileDiff, filename, commitTimestamp);
    
    // 统计AI贡献
    const aiAdditions = addedLines.filter(line => line.isAIGenerated).length;
    const aiDeletions = deletedLines.filter(line => line.isAIGenerated).length;
    
    return {
      filename,
      additions: totalAdditions,
      deletions: totalDeletions,
      aiAdditions,
      aiDeletions,
      addedLines,
      deletedLines
    };
  }

  /**
   * 从完整diff中提取特定文件的diff部分
   */
  private extractFileDiff(diffContent: string, filename: string): string | null {
    const lines = diffContent.split('\n');
    let inTargetFile = false;
    let fileDiffLines: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // 检测文件开始标记
      if (line.startsWith('diff --git') && line.includes(filename)) {
        inTargetFile = true;
        fileDiffLines = [line];
        continue;
      }
      
      // 检测下一个文件开始（结束当前文件）
      if (inTargetFile && line.startsWith('diff --git') && !line.includes(filename)) {
        break;
      }
      
      if (inTargetFile) {
        fileDiffLines.push(line);
      }
    }
    
    return fileDiffLines.length > 0 ? fileDiffLines.join('\n') : null;
  }

  /**
   * 解析diff中的添加和删除行，并匹配AI内容
   */
  private parseDiffLines(
    fileDiff: string, 
    filename: string, 
    commitTimestamp: number
  ): { addedLines: DiffLine[], deletedLines: DiffLine[] } {
    
    const lines = fileDiff.split('\n');
    const addedLines: DiffLine[] = [];
    const deletedLines: DiffLine[] = [];
    
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        // 添加的行
        const content = line.substring(1); // 去掉 '+' 前缀
        const aiMatch = this.matchLineToAI(content, '+', filename, commitTimestamp);
        
        addedLines.push({
          content,
          isAIGenerated: aiMatch.matched,
          aiItemHash: aiMatch.aiItem?.hash
        });
        
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // 删除的行
        const content = line.substring(1); // 去掉 '-' 前缀
        const aiMatch = this.matchLineToAI(content, '-', filename, commitTimestamp);
        
        deletedLines.push({
          content,
          isAIGenerated: aiMatch.matched,
          aiItemHash: aiMatch.aiItem?.hash
        });
      }
    }
    
    return { addedLines, deletedLines };
  }

  /**
   * 将diff行与AI存储内容进行精确匹配
   */
  private matchLineToAI(
    content: string,
    operation: '+' | '-',
    filename: string,
    commitTimestamp: number
  ): AIMatchResult {
    
    // 标准化内容（去除首尾空格，但保留缩进结构）
    const normalizedContent = content.trimEnd();
    
    // 从AI存储中查找匹配
    const allFileStats = this.aiCodeStorage.getAllFileStats();
    
    for (const [storedPath, fileStats] of allFileStats) {
      // 文件路径匹配检查（可能存在相对路径vs绝对路径的差异）
      if (!this.isPathMatch(filename, storedPath)) {
        continue;
      }
      
      // 遍历该文件的所有AI代码行
      for (const codeLine of fileStats.codeLines) {
        // 精确匹配条件：
        // 1. 内容完全一致
        // 2. 操作类型一致
        // 3. 时间窗口合理（AI生成时间应该在提交之前）
        
        if (this.isContentMatch(normalizedContent, codeLine.content) &&
            codeLine.operation === operation &&
            codeLine.timestamp <= commitTimestamp &&
            (commitTimestamp - codeLine.timestamp) < this.MAX_TIME_WINDOW) {
          
          return {
            matched: true,
            aiItem: codeLine,
            confidence: 1.0
          };
        }
      }
    }
    
    return {
      matched: false,
      confidence: 0.0
    };
  }

  /**
   * 检查文件路径是否匹配
   */
  private isPathMatch(diffPath: string, storedPath: string): boolean {
    // 简单的路径匹配：检查文件名是否在存储路径中
    const diffBasename = path.basename(diffPath);
    return storedPath.includes(diffBasename) || storedPath.endsWith(diffPath);
  }

  /**
   * 检查内容是否完全匹配
   */
  private isContentMatch(diffContent: string, aiContent: string): boolean {
    // 完全匹配（忽略首尾空格）
    return diffContent.trim() === aiContent.trim();
  }

  /**
   * 判断是否为代码文件
   */
  private isCodeFile(filename: string): boolean {
    const codeExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', 
      '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.dart',
      '.html', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
      '.json', '.yaml', '.yml', '.xml', '.sql', '.sh', '.bash'
    ];
    
    const ext = path.extname(filename).toLowerCase();
    return codeExtensions.includes(ext);
  }

  /**
   * 计算AI贡献统计
   */
  private calculateAIContribution(fileChanges: FileChange[]): {
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
    aiAdditions: number;
    aiDeletions: number;
    aiContributionPercentage: number;
  } {
    const stats = fileChanges.reduce((acc, file) => ({
      totalAdditions: acc.totalAdditions + file.additions,
      totalDeletions: acc.totalDeletions + file.deletions,
      aiAdditions: acc.aiAdditions + file.aiAdditions,
      aiDeletions: acc.aiDeletions + file.aiDeletions
    }), { totalAdditions: 0, totalDeletions: 0, aiAdditions: 0, aiDeletions: 0 });

    const totalChanges = stats.totalAdditions + stats.totalDeletions;
    const aiChanges = stats.aiAdditions + stats.aiDeletions;
    const percentage = totalChanges > 0 ? (aiChanges / totalChanges) * 100 : 0;

    return {
      totalFiles: fileChanges.length,
      ...stats,
      aiContributionPercentage: percentage
    };
  }

  /**
   * 缓存管理
   */
  private loadCache(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf8');
        this.cache = JSON.parse(data);
        console.log(`📊 [GIT_ANALYZER] Loaded cache with ${Object.keys(this.cache).length} entries`);
      }
    } catch (error) {
      console.error('Failed to load git commit cache:', error);
      this.cache = {};
    }
  }

  private saveCache(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error('Failed to save git commit cache:', error);
    }
  }

  private isCacheValid(commitHash: string): boolean {
    const cached = this.cache[commitHash];
    if (!cached) {
      return false;
    }

    // 检查是否过期（基于AI存储的版本）
    const currentAIVersion = this.getAIStorageVersion();
    return cached.aiStorageVersion === currentAIVersion && !cached.isStale;
  }

  private cacheAnalysis(commitHash: string, analysis: CommitInfo): void {
    this.cache[commitHash] = {
      hash: commitHash,
      analyzedAt: Date.now(),
      aiStorageVersion: this.getAIStorageVersion(),
      analysis,
      isStale: false
    };
    this.saveCache();
  }

  private getAIStorageVersion(): string {
    // 基于AI存储的最后修改时间生成版本号
    try {
      const storageDir = this.aiCodeStorage.getStorageDir();
      const statsFile = path.join(storageDir, 'ai-stats.json');
      if (fs.existsSync(statsFile)) {
        const stats = fs.statSync(statsFile);
        return stats.mtime.getTime().toString();
      }
    } catch (error) {
      console.error('Failed to get AI storage version:', error);
    }
    return Date.now().toString();
  }

  /**
   * 清理过期缓存
   */
  cleanupCache(maxAge: number = 30 * 24 * 60 * 60 * 1000): void { // 30天
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;

    Object.keys(this.cache).forEach(hash => {
      if (this.cache[hash].analyzedAt < cutoff) {
        delete this.cache[hash];
        cleaned++;
      }
    });

    if (cleaned > 0) {
      console.log(`🧹 [GIT_ANALYZER] Cleaned ${cleaned} old cache entries`);
      this.saveCache();
    }
  }
}
