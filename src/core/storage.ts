import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AICodeLine, AIFileStats } from './types';

/**
 * AI 代码本地存储管理器
 * 按文件维度存储AI生成的代码行，使用绝对路径
 */

// 类型已移动到 core/types

export class AICodeStorage {
  private storageDir: string;
  private fileStats: Map<string, AIFileStats> = new Map();
  private recentDocumentChanges: Map<string, Array<{ content: string, timestamp: number, operation: string }>> = new Map();

  constructor () {
    // 存储目录：~/.ailens/
    this.storageDir = path.join(os.homedir(), '.ailens');
    this.ensureStorageDir();
    this.loadExistingData();
  }

  /**
   * 确保存储目录存在
   */
  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
      // console.log(`📁 [AI_STORAGE] Created storage directory: ${this.storageDir}`);
    }
  }

  /**
   * 加载已存在的数据
   */
  private loadExistingData(): void {
    try {
      const statsFile = path.join(this.storageDir, 'ai-stats.json');
      if (fs.existsSync(statsFile)) {
        const data = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        // 重建Map
        for (const [filePath, stats] of Object.entries(data)) {
          this.fileStats.set(filePath, stats as AIFileStats);
        }
        // console.log(`📊 [AI_STORAGE] Loaded stats for ${this.fileStats.size} files`);
      }
    } catch (error) {
      console.error('❌ [AI_STORAGE] Failed to load existing data:', error);
    }
  }

  /**
   * 保存数据到磁盘
   */
  private saveData(): void {
    try {
      const statsFile = path.join(this.storageDir, 'ai-stats.json');
      const data = Object.fromEntries(this.fileStats);
      fs.writeFileSync(statsFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      console.error('❌ [AI_STORAGE] Failed to save data:', error);
    }
  }

  /**
   * 记录文档变化用于hash恢复
   */
  recordDocumentChange(fileName: string, content: string, operation: string): void {
    if (!this.recentDocumentChanges.has(fileName)) {
      this.recentDocumentChanges.set(fileName, []);
    }

    const changes = this.recentDocumentChanges.get(fileName)!;
    changes.push({
      content: content,
      timestamp: Date.now(),
      operation: operation
    });

    // 只保留最近10分钟的变化
    const cutoff = Date.now() - 10 * 60 * 1000;
    const filteredChanges = changes.filter(change => change.timestamp > cutoff);
    this.recentDocumentChanges.set(fileName, filteredChanges);
  }

  /**
   * 处理新的AI项目列表
   */
  // processAIItems方法已删除 - 现在只通过hash匹配回调更新统计

  // 反推逻辑与 MurmurHash 实现均已集中在 hashing 模块（line-inference/HashUtils），此处不再重复

  /**
   * 存储AI代码行
   */
  storeAICodeLine(absolutePath: string, relativePath: string, codeLine: AICodeLine): void {
    if (!this.fileStats.has(absolutePath)) {
      this.fileStats.set(absolutePath, {
        absolutePath,
        relativePath,
        totalAILines: 0,
        addedLines: 0,
        deletedLines: 0,
        lastUpdate: Date.now(),
        codeLines: []
      });
    }

    const fileStats = this.fileStats.get(absolutePath)!;

    // 检查是否已存在相同哈希（避免重复）
    const exists = fileStats.codeLines.some(line => line.hash === codeLine.hash);
    if (exists) {
      return; // 已存在，跳过
    }

    fileStats.codeLines.push(codeLine);
    fileStats.totalAILines++;
    fileStats.lastUpdate = Date.now();

    if (codeLine.operation === '+') {
      fileStats.addedLines++;
    } else if (codeLine.operation === '-') {
      fileStats.deletedLines++;
    }

    // 立即保存到磁盘
    this.saveData();

    // console.log(`📝 [STORE] ${relativePath}: ${codeLine.operation} "${codeLine.content.substring(0, 50)}${codeLine.content.length > 50 ? '...' : ''}"`);
  }

  /**
   * 获取所有文件的统计信息
   */
  getAllFileStats(): Map<string, AIFileStats> {
    return new Map(this.fileStats);
  }

  /**
   * 获取特定文件的统计信息
   */
  getFileStats(absolutePath: string): AIFileStats | undefined {
    return this.fileStats.get(absolutePath);
  }

  /**
   * 获取总体统计
   */
  getTotalStats(): {
    totalFiles: number;
    totalAILines: number;
    totalAddedLines: number;
    totalDeletedLines: number;
    fileBreakdown: { path: string; lines: number }[];
  } {
    let totalAILines = 0;
    let totalAddedLines = 0;
    let totalDeletedLines = 0;
    const fileBreakdown: { path: string; lines: number }[] = [];

    for (const [absolutePath, stats] of this.fileStats) {
      totalAILines += stats.totalAILines;
      totalAddedLines += stats.addedLines;
      totalDeletedLines += stats.deletedLines;

      fileBreakdown.push({
        path: stats.relativePath,
        lines: stats.totalAILines
      });
    }

    // 按AI行数排序
    fileBreakdown.sort((a, b) => b.lines - a.lines);

    return {
      totalFiles: this.fileStats.size,
      totalAILines,
      totalAddedLines,
      totalDeletedLines,
      fileBreakdown
    };
  }

  /**
   * 导出数据到JSON文件
   */
  exportToFile(exportPath?: string): string {
    const stats = this.getTotalStats();
    const exportData = {
      exportTime: new Date().toISOString(),
      summary: stats,
      files: Object.fromEntries(this.fileStats)
    };

    const outputPath = exportPath || path.join(this.storageDir, `ai-export-${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf8');

    console.log(`📄 [EXPORT] Data exported to: ${outputPath}`);
    return outputPath;
  }

  /**
   * 清理过期数据
   */
  cleanup(maxAge: number = 30 * 24 * 60 * 60 * 1000): void { // 30天
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;

    for (const [absolutePath, stats] of this.fileStats) {
      if (stats.lastUpdate < cutoff) {
        this.fileStats.delete(absolutePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 [CLEANUP] Removed ${cleaned} old file records`);
      this.saveData();
    }
  }

  /**
   * 获取存储目录路径
   */
  getStorageDir(): string {
    return this.storageDir;
  }

  /**
   * 查找指定hash的匹配结果
   */
  findMatchForHash(targetHash: string): { content: string; operation: '+' | '-'; source?: string } | null {
    // 遍历所有文件的代码行，查找匹配的hash
    for (const [absolutePath, stats] of this.fileStats) {
      const matchingLine = stats.codeLines.find(line => line.hash === targetHash);
      if (matchingLine) {
        return {
          content: matchingLine.content,
          operation: matchingLine.operation,
          source: 'stored_code'
        };
      }
    }

    return null;
  }
}
