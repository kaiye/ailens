import * as vscode from 'vscode';
import { AICodeItem } from '../core/types';
import { HashUtils } from './hash';

/**
 * 行级内容信息
 */
export interface LineContent {
  lineNumber: number;
  content: string;
  operation: '+' | '-';
  timestamp: number;
  fileName: string;
  used?: boolean; // 标记是否已被匹配使用
}

/**
 * Hash 推断结果
 */
export interface HashInferenceResult {
  hash: string;
  content: string;
  operation: '+' | '-';
  lineNumber?: number;
  source: 'full_line' | 'deleted_fragment';
}

/**
 * 基于行的 Hash 内容推断引擎 - 极简版本
 * 核心逻辑：拿AI item → 遍历记录的{fileName, op, content} → 计算hash → 比对
 */
export class LineBasedHashInference {
  private recentLines: Map<string, LineContent[]> = new Map();
  private hashToContentCache: Map<string, HashInferenceResult> = new Map(); // Hash到内容的缓存映射
  private readonly TIME_WINDOW = 300000; // 300秒时间窗口 (增加容忍度)
  private readonly MAX_LINES_PER_FILE = 1000; // 每个文件最多缓存1000行变化
  private readonly MAX_CACHE_SIZE = 5000; // 最大缓存条目数

  constructor (
    private onHashMatchFound?: (aiItem: AICodeItem, result: HashInferenceResult, fileName: string) => void
  ) { }

  /**
   * 记录行内容变化
   */
  recordLineContent(lineContent: LineContent): void {
    const fileName = lineContent.fileName;

    if (!this.recentLines.has(fileName)) {
      this.recentLines.set(fileName, []);
    }

    const lines = this.recentLines.get(fileName)!;
    lines.push(lineContent);

    // 限制缓存大小
    if (lines.length > this.MAX_LINES_PER_FILE) {
      lines.splice(0, lines.length - this.MAX_LINES_PER_FILE);
    }
  }

  /**
   * 推断AI代码项的内容 - 正序遍历保持时间顺序
   */
  inferHashContents(aiItems: AICodeItem[], inferenceTime: number): HashInferenceResult[] {
    console.log(`\n🧠 Hash Inference Engine - Processing ${aiItems.length} AI items (chronological order)`);

    const results: HashInferenceResult[] = [];

    // 正序遍历AI items（保持时间顺序）
    for (const aiItem of aiItems) {
      const result = this.inferSingleHash(aiItem, inferenceTime);
      if (result) {
        results.push(result);
      }
    }

    console.log(`📊 Hash Inference Results: ${results.length}/${aiItems.length} items resolved`);

    return results;
  }

  /**
   * 推断单个 Hash 的内容 - 优化版本，支持缓存和记录标记
   */
  private inferSingleHash(aiItem: AICodeItem, inferenceTime: number): HashInferenceResult | null {
    const aiFileName = aiItem.metadata?.fileName;
    if (!aiFileName) {
      return null;
    }

    // 1. 先检查hash缓存
    if (this.hashToContentCache.has(aiItem.hash)) {
      console.log(`\n   💾 Cache hit for hash: ${aiItem.hash}`);
      return this.hashToContentCache.get(aiItem.hash)!;
    }

    console.log(`\n   🔍 Inferring hash: ${aiItem.hash} for file: ${aiFileName}`);

    let attemptCount = 0;

    // 正序遍历文件列表（保持时间顺序）
    const fileEntries = Array.from(this.recentLines.entries());

    console.log(`   🗂️  Available files in cache: ${fileEntries.map(([name, lines]) => `${name}(${lines.length})`).join(', ')}`);

    for (const [recordFileName, lineContents] of fileEntries) {
      // 文件名相关性检查
      if (!this.isFileNameRelated(aiFileName, recordFileName)) {
        console.log(`   🚫 Skipped unrelated file: ${recordFileName}`);
        continue;
      }

      console.log(`   📂 Checking records from file: ${recordFileName} (${lineContents.length} records)`);

      let skippedUsed = 0;
      let validRecords = 0;

      // 正序检查记录（保持时间顺序）
      for (let i = 0; i < lineContents.length; i++) {
        const record = lineContents[i];
        const recordAge = inferenceTime - record.timestamp;
        const recordTime = new Date(record.timestamp).toISOString();

        // 跳过已使用的记录
        if (record.used) {
          skippedUsed++;
          console.log(`   🔄 Record ${i}: USED - Time: ${recordTime}, Age: ${recordAge}ms, Content: "${record.content.substring(0, 30)}..."`);
          continue;
        }

        console.log(`   ✅ Record ${i}: AVAILABLE - Time: ${recordTime}, Age: ${recordAge}ms, Op: ${record.operation}, Content: "${record.content.substring(0, 50)}..."`);

        validRecords++;
        attemptCount++;

        // 计算hash: 先尝试原始aiFileName
        let hashInput = `${aiFileName}${record.operation}${record.content}`;
        let calculatedHash = HashUtils.calculateCodeHash(aiFileName, record.operation, record.content);

        console.log(`   🧮 Hash #${attemptCount}a: input="${hashInput}" -> ${calculatedHash} (target: ${aiItem.hash})`);

        if (calculatedHash === aiItem.hash) {
          console.log(`   🎯 MATCH FOUND with original filename!`);

          // 标记该记录为已使用
          record.used = true;

          // 创建结果对象
          const result: HashInferenceResult = {
            hash: aiItem.hash,
            content: record.content,
            operation: record.operation,
            lineNumber: record.lineNumber,
            source: record.operation === '+' ? 'full_line' : 'deleted_fragment'
          };

          // 缓存结果
          this.hashToContentCache.set(aiItem.hash, result);
          this.checkCacheSize();

          // 触发AI统计更新回调
          this.onHashMatchFound?.(aiItem, result, aiFileName);

          return result;
        }

        // 如果aiFileName是绝对路径，尝试转换为相对路径再计算hash
        if (this.isAbsolutePath(aiFileName)) {
          const relativePath = this.getRelativeFileName(aiFileName);
          if (relativePath !== aiFileName) {
            hashInput = `${relativePath}${record.operation}${record.content}`;
            calculatedHash = HashUtils.calculateCodeHash(relativePath, record.operation, record.content);

            console.log(`   🧮 Hash #${attemptCount}b: input="${hashInput}" -> ${calculatedHash} (target: ${aiItem.hash})`);

            if (calculatedHash === aiItem.hash) {
              console.log(`   🎯 MATCH FOUND with relative path!`);

              // 标记该记录为已使用
              record.used = true;

              // 创建结果对象
              const result: HashInferenceResult = {
                hash: aiItem.hash,
                content: record.content,
                operation: record.operation,
                lineNumber: record.lineNumber,
                source: record.operation === '+' ? 'full_line' : 'deleted_fragment'
              };

              // 缓存结果
              this.hashToContentCache.set(aiItem.hash, result);
              this.checkCacheSize();

              // 触发AI统计更新回调
              this.onHashMatchFound?.(aiItem, result, relativePath);

              return result;
            }
          }
        }
      }

      // 输出记录跳过统计
      console.log(`   📋 Records summary: Valid=${validRecords}, SkippedUsed=${skippedUsed}`);
      if (validRecords === 0) {
        console.log(`   ⚠️  No valid records found in file: ${recordFileName}`);
      }
    }

    console.log(`   ❌ No match found for hash: ${aiItem.hash} after ${attemptCount} attempts`);
    return null;
  }

  /**
   * 检查是否为绝对路径
   */
  private isAbsolutePath(filePath: string): boolean {
    // Unix/Linux/Mac: 以 / 开头
    // Windows: 以 C: 等盘符开头或以 \\ 开头
    return filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath) || filePath.startsWith('\\\\');
  }

  /**
   * 将绝对路径转换为相对路径
   */
  private getRelativeFileName(filePath: string): string {
    // 使用VS Code的workspace API获取相对路径
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return filePath;
    }

    for (const folder of workspaceFolders) {
      const workspacePath = folder.uri.fsPath;
      if (filePath.startsWith(workspacePath)) {
        const relativePath = filePath.substring(workspacePath.length);
        // 移除前导的路径分隔符
        return relativePath.startsWith('/') || relativePath.startsWith('\\')
          ? relativePath.substring(1)
          : relativePath;
      }
    }

    return filePath;
  }

  /**
   * 检查文件名相关性
   */
  private isFileNameRelated(aiFileName: string, docFileName: string): boolean {
    // 精确匹配
    if (aiFileName === docFileName) {
      return true;
    }

    // 包含关系检查
    if (aiFileName.includes(docFileName) || docFileName.includes(aiFileName)) {
      return true;
    }

    // 基名匹配
    const aiBaseName = aiFileName.split('/').pop() || '';
    const docBaseName = docFileName.split('/').pop() || '';
    if (aiBaseName === docBaseName && aiBaseName !== '') {
      return true;
    }

    return false;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalFiles: number;
    totalLines: number;
    usedLines: number;
    cacheSize: number;
    oldestTimestamp: number;
    newestTimestamp: number;
  } {
    let totalLines = 0;
    let usedLines = 0;
    let oldestTimestamp = Date.now();
    let newestTimestamp = 0;

    for (const lines of this.recentLines.values()) {
      totalLines += lines.length;

      for (const line of lines) {
        if (line.used) {
          usedLines++;
        }
        if (line.timestamp < oldestTimestamp) {
          oldestTimestamp = line.timestamp;
        }
        if (line.timestamp > newestTimestamp) {
          newestTimestamp = line.timestamp;
        }
      }
    }

    return {
      totalFiles: this.recentLines.size,
      totalLines,
      usedLines,
      cacheSize: this.hashToContentCache.size,
      oldestTimestamp,
      newestTimestamp
    };
  }

  /**
   * 检查缓存大小并清理
   */
  private checkCacheSize(): void {
    if (this.hashToContentCache.size > this.MAX_CACHE_SIZE) {
      // 简单的FIFO策略，清理一半缓存
      const entries = Array.from(this.hashToContentCache.entries());
      const keepCount = Math.floor(this.MAX_CACHE_SIZE / 2);

      this.hashToContentCache.clear();

      // 保留后一半
      for (let i = entries.length - keepCount; i < entries.length; i++) {
        const [hash, result] = entries[i];
        this.hashToContentCache.set(hash, result);
      }

      console.log(`🧹 Hash cache cleanup: kept ${this.hashToContentCache.size} entries`);
    }
  }

  /**
   * 清理过期数据
   */
  cleanup(maxAge: number = 300000): void { // 5分钟，但只清理已使用的记录
    const cutoff = Date.now() - maxAge;

    for (const [fileName, lines] of this.recentLines.entries()) {
      // 只清理已使用且过期的记录，未使用的记录永久保留
      const filteredLines = lines.filter(line => {
        if (line.used) {
          // 已使用的记录：根据时间清理
          return line.timestamp >= cutoff;
        } else {
          // 未使用的记录：永久保留
          return true;
        }
      });

      if (filteredLines.length === 0) {
        this.recentLines.delete(fileName);
      } else {
        this.recentLines.set(fileName, filteredLines);
      }
    }
  }
}
