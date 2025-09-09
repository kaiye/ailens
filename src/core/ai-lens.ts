import { AICodeItem, MatchResult, AICodeStats, DocumentChange, AICodeAnalysisResult } from './types';
import { HashUtils } from '../hashing/hash';
import { CursorDatabase } from '../providers/cursor/cursor-database';
import { TimingAnalyzer } from '../analysis/timing-analyzer';
import { CodeOperationAnalyzer } from '../analysis/code-operation-analyzer';
import { AICodeStorage } from './storage';
import { LineBasedHashInference, HashInferenceResult } from '../hashing/line-inference';
import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceUtils } from '../utils/workspace-utils';
import { StatsAggregator } from './stats-aggregator';

/**
 * AI Code Analyzer - 核心分析引擎
 */
export class AICodeAnalyzer {
  private database: CursorDatabase;
  private lastKnownItems: AICodeItem[] = [];
  private lastItemHash: string | null = null;
  private matchedHashes = new Set<string>();
  private stopDatabaseWatcher?: () => void;
  private timingAnalyzer?: TimingAnalyzer;
  private codeOperationAnalyzer: CodeOperationAnalyzer;
  private aiCodeStorage: AICodeStorage;
  private statsAggregator: StatsAggregator;

  // 未匹配项队列（用于document change推断）
  private unmatchedAIItems: AICodeItem[] = [];

  // 新的Hash推断引擎（从 DocumentMonitor 获取）
  private hashInferenceEngine?: LineBasedHashInference;

  // 统计数据
  private stats: AICodeStats = {
    totalLines: 0,
    aiGeneratedLines: 0,
    tabCompletionLines: 0,
    composerLines: 0,
    percentage: 0,
    files: new Map()
  };

  constructor () {
    this.database = new CursorDatabase();
    this.codeOperationAnalyzer = new CodeOperationAnalyzer();
    this.aiCodeStorage = new AICodeStorage();
    this.statsAggregator = new StatsAggregator(this.aiCodeStorage);
  }

  /**
   * 设置 Hash 推断引擎（从 DocumentMonitor 获取）
   */
  setHashInferenceEngine(engine: LineBasedHashInference): void {
    this.hashInferenceEngine = engine;
  }

  /**
 * 设置时序分析器
 */
  setTimingAnalyzer(timingAnalyzer: TimingAnalyzer): void {
    this.timingAnalyzer = timingAnalyzer;
  }

  /**
   * 记录文档变化用于操作分析和hash恢复
   */
  recordDocumentChangeForOperationAnalysis(change: DocumentChange): void {
    this.codeOperationAnalyzer.recordDocumentChange(change);

    // 同时记录到AI代码存储器，用于hash恢复
    this.aiCodeStorage.recordDocumentChange(
      change.document,
      change.text,
      change.operation || 'unknown'
    );
  }

  /**
   * 初始化分析器
   */
  async initialize(): Promise<void> {
    const status = await this.database.getStatus();

    if (!status.exists) {
      throw new Error('Cursor database not found. Please make sure Cursor is installed.');
    }

    if (!status.accessible) {
      throw new Error(`Cursor database is not accessible: ${status.error}`);
    }

    console.log('\n📊 AI Analyzer: Initializing - loading existing AI tracking items...');

    // 加载现有的AI追踪项
    try {
      const items = await this.database.loadAITrackingItems();
      if (items && Array.isArray(items)) {
        this.lastKnownItems = [...items];
        if (items.length > 0) {
          this.lastItemHash = items[items.length - 1].hash;
        }
        console.log(`   ✅ Loaded ${items.length} existing items, last hash: ${this.lastItemHash?.substring(0, 8) || 'none'}...`);
      } else {
        this.lastKnownItems = [];
        this.lastItemHash = null;
        console.log('   📝 No existing items found');
      }
    } catch (error) {
      console.error('   ❌ Failed to load AI tracking items:', error);
      throw error;
    }

    // 从存储器加载统计数据
    this.updateStatsFromStorage();

  }

  /**
   * 开始监听数据库变化
   */
  startMonitoring(): void {
    if (this.stopDatabaseWatcher) {
      this.stopDatabaseWatcher();
    }

    try {
      this.stopDatabaseWatcher = this.database.watchForChanges(() => {
        this.checkForNewItems();
      });
      console.log('AI Lens: Started database monitoring');
    } catch (error) {
      console.error('AI Lens: Failed to start database monitoring:', error);
      throw error;
    }
  }

  /**
   * 停止监听
   */
  stopMonitoring(): void {
    if (this.stopDatabaseWatcher) {
      this.stopDatabaseWatcher();
      this.stopDatabaseWatcher = undefined;
      console.log('AI Lens: Stopped database monitoring');
    }
  }

  /**
   * 检查新的AI代码项 - 简化日志版本
   */
  private async checkForNewItems(): Promise<void> {
    try {
      const currentItems = await this.database.loadAITrackingItems();
      if (!currentItems || !Array.isArray(currentItems)) {
        return;
      }

      const currentLastHash = currentItems.length > 0 ? currentItems[currentItems.length - 1].hash : null;
      let newItems: AICodeItem[] = [];

      if (this.lastItemHash === null) {
        // 首次检查，所有项都是新的
        newItems = [...currentItems];
      } else if (currentLastHash !== this.lastItemHash) {
        // 找到上次最后一个哈希在当前数组中的位置
        const lastKnownIndex = currentItems.findIndex(item => item.hash === this.lastItemHash);

        if (lastKnownIndex === -1) {
          // 上次的最后一个哈希不在当前数组中，说明数组变化很大
          const lastKnownHashSet = new Set(this.lastKnownItems.map(item => item.hash));
          newItems = currentItems.filter(item => !lastKnownHashSet.has(item.hash));
        } else {
          // 从上次已知位置之后的所有项都是新增的
          newItems = currentItems.slice(lastKnownIndex + 1);
        }
      }

      // 更新已知状态
      this.lastKnownItems = [...currentItems];
      if (currentItems.length > 0) {
        this.lastItemHash = currentItems[currentItems.length - 1].hash;
      }


      if (newItems.length > 0) {
        // 给新检测到的AI items添加时间戳
        const detectionTime = Date.now();
        const itemsWithTimestamp = newItems.map(item => ({
          ...item,
          timestamp: detectionTime,
          detectedAt: detectionTime
        }));

        // 输出原始 SQLite AI item 信息，现在包含时间戳
        console.log(`\n=== NEW AI ITEMS FROM SQLITE (${itemsWithTimestamp.length}) ===`);
        itemsWithTimestamp.forEach((item, index) => {
          console.log(`Raw AI Item ${index + 1}:`, JSON.stringify(item, null, 2));
        });
        console.log(`=== END NEW AI ITEMS ===\n`);


        await this.processNewAIItems(itemsWithTimestamp);
      }

    } catch (error) {
      console.error('Error checking for new items:', error);
    }
  }


  /**
   * 处理新的AI代码项 - 使用Hash推断引擎
   */
  private async processNewAIItems(newItems: AICodeItem[]): Promise<void> {
    try {
      console.log(`   🔍 Processing ${newItems.length} new AI items`);

      // 使用Hash推断引擎进行精确匹配
      if (this.hashInferenceEngine) {
        const inferenceTime = Date.now();
        const inferenceResults = this.hashInferenceEngine.inferHashContents(newItems, inferenceTime);

        // 处理推断结果
        for (const result of inferenceResults) {
          const matchResult = {
            found: true,
            content: result.content,
            operation: result.operation,
            lineNumber: result.lineNumber,
            source: `hash_inference_${result.source}`
          };

          this.markAsMatched(result.hash, matchResult);

          // 从未匹配队列中移除（如果存在）
          this.unmatchedAIItems = this.unmatchedAIItems.filter(item => item.hash !== result.hash);
        }
      } else {
        console.log(`   ⚠️  Hash inference engine not available`);
      }
    } catch (error) {
      console.error('   ❌ Error in processNewAIItems:', error);
      throw error; // 重新抛出错误，让上层处理
    }
  }


  /**
   * 标记哈希为已匹配
   */
  private markAsMatched(hash: string, matchResult: any = null): void {
    const isNewMatch = !this.matchedHashes.has(hash);

    this.matchedHashes.add(hash);

    // 如果是新匹配，报告发现
    if (isNewMatch && matchResult) {
      this.reportMatch(hash, matchResult);
    }
  }

  /**
   * 报告找到的匹配
   */
  private reportMatch(hash: string, matchResult: any): void {
    const hashPreview = hash.substring(0, 8);
    const source = matchResult.source || 'unknown';
    console.log(`      ✅ MATCH FOUND: ${hashPreview}... (${source})`);

    if (matchResult.content) {
      const preview = matchResult.content.length > 30 ? matchResult.content.substring(0, 30) + '...' : matchResult.content;
      console.log(`         Content: "${preview}"`);
    }

    if (matchResult.operation) {
      console.log(`         Operation: ${matchResult.operation}`);
    }

    // 显示hash推断特有的信息

    if (matchResult.lineNumber !== undefined) {
      console.log(`         Line Number: ${matchResult.lineNumber}`);
    }
  }




  /**
   * 根据存储器数据更新统计
   */
  private updateStatsFromStorage(): void {
    this.statsAggregator.updateFromStorage(this.stats);
    console.log(`📊 [STATS_UPDATE] AI lines: ${this.stats.aiGeneratedLines}, Files: ${this.stats.files.size}`);
  }







  /**
   * 更新统计数据
   */
  private async updateStats(): Promise<void> {
    await this.statsAggregator.refreshTotals(this.stats);
    console.log(`📊 [UPDATE_STATS] AI: ${this.stats.aiGeneratedLines}/${this.stats.totalLines} = ${this.stats.percentage.toFixed(3)}%`);
  }



  /**
   * 获取当前统计数据
   */
  getStats(): AICodeStats {
    this.statsAggregator.updateSourceBreakdown(this.stats);
    console.log(`📊 [GET_STATS] AI: ${this.stats.aiGeneratedLines}/${this.stats.totalLines} = ${this.stats.percentage.toFixed(3)}%`);
    return { ...this.stats };
  }


  /**
   * 获取AI代码存储实例
   */
  getAICodeStorage() {
    return this.aiCodeStorage;
  }

  /**
   * 手动处理document change，尝试匹配未匹配的AI项目
   */
  async processDocumentChangeForMatching(fileName: string, content: string, operation: '+' | '-'): Promise<void> {
    if (this.unmatchedAIItems.length === 0) {
      return;
    }

    // 计算这个document change的哈希
    const hashInput = `${fileName}:${operation}${content}`;
    const calculatedHash = HashUtils.murmurhash3(hashInput, 0);

    // 查找是否有匹配的未匹配项目
    const matchingIndex = this.unmatchedAIItems.findIndex(item => item.hash === calculatedHash);

    if (matchingIndex !== -1) {

      // 从未匹配队列中移除
      this.unmatchedAIItems.splice(matchingIndex, 1);

      // 标记为已匹配
      const matchResult = {
        found: true,
        content: content,
        operation: operation,
        source: 'document_change',
        hashInput: hashInput
      };

      this.markAsMatched(calculatedHash, matchResult);

      console.log(`🎯 [DOC_MATCH] Matched AI item ${calculatedHash.substring(0, 8)}... with document change!`);
      console.log(`   File: ${fileName}, Operation: ${operation}, Content: "${content.substring(0, 50)}..."`);

      // 更新统计
      await this.updateStats();
    }
  }

  /**
   * 获取数据库状态
   */
  async getDatabaseStatus() {
    return await this.database.getStatus();
  }

  /**
   * 获取综合状态（包含统计、分析器状态和数据库状态）
   */
  async getFullStatus() {
    const [stats, analyzerStatus, dbStatus] = await Promise.all([
      Promise.resolve(this.getStats()),
      Promise.resolve(this.getStatus()),
      this.getDatabaseStatus()
    ]);

    return {
      stats,
      analyzerStatus,
      dbStatus,
      timestamp: Date.now()
    };
  }

  /**
   * 获取分析器状态
   */
  getStatus(): {
    initialized: boolean;
    monitoring: boolean;
    totalItems: number;
    matchedItems: number;
    unmatchedItems: number;
    lastItemHash: string | null;
    lastUpdateTime: string;
  } {
    return {
      initialized: this.lastKnownItems.length > 0,
      monitoring: this.stopDatabaseWatcher !== undefined,
      totalItems: this.lastKnownItems.length,
      matchedItems: this.matchedHashes.size,
      unmatchedItems: this.unmatchedAIItems.length,
      lastItemHash: this.lastItemHash,
      lastUpdateTime: Date.now().toString()
    };
  }

  /**
   * 手动触发统计更新
   */
  async refreshStats(): Promise<void> {
    // 刷新文件总行数与百分比
    await this.statsAggregator.refreshTotals(this.stats);
  }

  /**
   * 处理Hash匹配成功时的AI统计更新
   */
  updateAIStatsOnHashMatch(aiItem: any, result: any, fileName: string): void {
    try {
      const workspaceRoot = WorkspaceUtils.getWorkspaceRoot();
      if (!workspaceRoot) {
        console.warn('No workspace root found for AI stats update');
        return;
      }

      // 构建绝对路径
      let absolutePath: string;
      if (path.isAbsolute(fileName)) {
        absolutePath = fileName;
      } else {
        absolutePath = path.join(workspaceRoot, fileName);
      }

      const relativePath = WorkspaceUtils.toRelativePath(absolutePath);

      // 创建AI代码行记录，使用解码后的原始内容
      const aiCodeLine = {
        hash: aiItem.hash,
        operation: result.operation,
        content: result.content, // 使用hash解码出的原始内容
        timestamp: aiItem.metadata?.timestamp || Date.now(),
        source: aiItem.metadata?.source || 'unknown',
        line: result.lineNumber
      };

      // 直接调用storage的storeAICodeLine方法
      this.aiCodeStorage.storeAICodeLine(absolutePath, relativePath, aiCodeLine);

      console.log(`📝 AI stats updated: ${relativePath} ${result.operation} "${result.content.substring(0, 50)}${result.content.length > 50 ? '...' : ''}"`);
    } catch (error) {
      console.error('Error updating AI stats on hash match:', error);
    }
  }
}
