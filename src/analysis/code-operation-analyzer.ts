import { DocumentChange, AICodeItem, AICodeOperation, AICodeAnalysisResult } from '../core/types';

/**
 * AI 代码操作分析器
 * 基于文档变化和AI项目的时序关系，分析AI删除、修改和插入的代码行数
 */
export class CodeOperationAnalyzer {
  private recentDocumentChanges: DocumentChange[] = [];
  private readonly MAX_CHANGES = 100;
  private readonly CORRELATION_WINDOW = 10000; // 10秒窗口

  /**
   * 记录文档变化
   */
  recordDocumentChange(change: DocumentChange): void {
    this.recentDocumentChanges.push(change);

    // 保持队列大小
    if (this.recentDocumentChanges.length > this.MAX_CHANGES) {
      this.recentDocumentChanges.splice(0, this.recentDocumentChanges.length - this.MAX_CHANGES);
    }

    // 清理超出时间窗口的变化
    const cutoff = Date.now() - this.CORRELATION_WINDOW;
    this.recentDocumentChanges = this.recentDocumentChanges.filter(
      change => change.timestamp >= cutoff
    );
  }

  /**
   * 分析AI项目对应的代码操作
   */
  analyzeAIOperations(aiItems: AICodeItem[]): AICodeAnalysisResult {
    const operations: AICodeOperation[] = [];
    let totalDeletedLines = 0;
    let totalModifiedLines = 0;
    let totalInsertedLines = 0;
    let matchedChangeId: string | undefined;

    // console.log('🔍 [CODE_OPERATION_ANALYSIS]', {
    //   timestamp: new Date().toISOString(),
    //   aiItemsCount: aiItems.length,
    //   recentChangesCount: this.recentDocumentChanges.length,
    //   analysisWindow: `${this.CORRELATION_WINDOW}ms`
    // });

    for (const aiItem of aiItems) {
      const analysis = this.analyzeAIItem(aiItem);
      if (analysis) {
        operations.push(...analysis.operations);
        totalDeletedLines += analysis.totalDeletedLines;
        totalModifiedLines += analysis.totalModifiedLines;
        totalInsertedLines += analysis.totalInsertedLines;

        if (analysis.matchedChangeId) {
          matchedChangeId = analysis.matchedChangeId;
        }
      }
    }

    const result: AICodeAnalysisResult = {
      totalDeletedLines,
      totalModifiedLines,
      totalInsertedLines,
      operations,
      matchedChangeId
    };

    this.logAnalysisResult(result);
    return result;
  }

  /**
   * 分析单个AI项目
   */
  private analyzeAIItem(aiItem: AICodeItem): AICodeAnalysisResult | null {
    const fileName = aiItem.metadata.fileName;
    const aiTimestamp = aiItem.metadata.timestamp;

    // 查找相关的文档变化（在AI项目之前发生的）
    const relatedChanges = this.recentDocumentChanges.filter(change =>
      change.document === fileName &&
      change.timestamp <= aiTimestamp + 2000 && // AI项目可能在文档变化后2秒内出现
      change.timestamp >= aiTimestamp - 5000    // 但文档变化应该在AI项目前5秒内
    ).sort((a, b) => Math.abs(a.timestamp - aiTimestamp) - Math.abs(b.timestamp - aiTimestamp));

    if (relatedChanges.length === 0) {
      return null;
    }

    console.log('🔗 [FOUND_RELATED_CHANGES]', {
      aiItem: aiItem.hash,
      file: fileName,
      relatedChangesCount: relatedChanges.length,
      timeDeltas: relatedChanges.map(c => aiTimestamp - c.timestamp)
    });

    // 分析每个相关变化
    const operations: AICodeOperation[] = [];
    let bestMatch: DocumentChange | null = null;
    let bestScore = 0;

    for (const change of relatedChanges) {
      const score = this.calculateMatchScore(aiItem, change);
      console.log('📊 [MATCH_SCORE]', {
        changeId: change.changeId,
        operation: change.operation,
        score: score.toFixed(2),
        factors: {
          timeProximity: Math.abs(aiTimestamp - change.timestamp),
          operationType: change.operation,
          contentLength: change.text.length
        }
      });

      if (score > bestScore) {
        bestScore = score;
        bestMatch = change;
      }

      // 基于变化类型创建操作记录
      const operation = this.createOperation(change, aiItem);
      if (operation) {
        operations.push(operation);
      }
    }

    if (!bestMatch) {
      return null;
    }

    // 统计各种操作的行数
    const stats = this.calculateOperationStats(operations);

    return {
      totalDeletedLines: stats.deletedLines,
      totalModifiedLines: stats.modifiedLines,
      totalInsertedLines: stats.insertedLines,
      operations,
      matchedChangeId: bestMatch.changeId
    };
  }

  /**
   * 计算AI项目和文档变化的匹配分数
   */
  private calculateMatchScore(aiItem: AICodeItem, change: DocumentChange): number {
    let score = 0;

    // 时间接近度（50%权重）
    const timeDelta = Math.abs(aiItem.metadata.timestamp - change.timestamp);
    const timeScore = Math.max(0, 1 - timeDelta / this.CORRELATION_WINDOW);
    score += timeScore * 0.5;

    // 内容长度合理性（30%权重）
    const contentLength = change.text.length;
    const lengthScore = contentLength > 10 ? Math.min(1, contentLength / 100) : 0.1;
    score += lengthScore * 0.3;

    // 操作类型合理性（20%权重）
    let operationScore = 0;
    if (change.operation === 'insert' && aiItem.metadata.source === 'tab') {
      operationScore = 0.9; // Tab补全通常是插入
    } else if (change.operation === 'replace' && aiItem.metadata.source === 'composer') {
      operationScore = 0.8; // Composer可能是替换
    } else if (change.operation === 'delete') {
      operationScore = 0.6; // 删除操作相对少见
    } else {
      operationScore = 0.4; // 其他情况
    }
    score += operationScore * 0.2;

    return score;
  }

  /**
   * 创建操作记录
   */
  private createOperation(change: DocumentChange, aiItem: AICodeItem): AICodeOperation | null {
    let type: 'delete' | 'modify' | 'insert';
    let linesCount = 0;

    switch (change.operation) {
      case 'delete':
        type = 'delete';
        linesCount = change.affectedLines;
        break;
      case 'replace':
        type = 'modify';
        linesCount = change.affectedLines;
        break;
      case 'insert':
        type = 'insert';
        linesCount = change.text.split('\n').length - 1 || 1;
        break;
      default:
        return null;
    }

    return {
      type,
      linesCount,
      content: change.text,
      originalContent: change.beforeText,
      file: change.document,
      timestamp: change.timestamp
    };
  }

  /**
   * 计算操作统计
   */
  private calculateOperationStats(operations: AICodeOperation[]): {
    deletedLines: number;
    modifiedLines: number;
    insertedLines: number;
  } {
    return operations.reduce((stats, op) => {
      switch (op.type) {
        case 'delete':
          stats.deletedLines += op.linesCount;
          break;
        case 'modify':
          stats.modifiedLines += op.linesCount;
          break;
        case 'insert':
          stats.insertedLines += op.linesCount;
          break;
      }
      return stats;
    }, { deletedLines: 0, modifiedLines: 0, insertedLines: 0 });
  }

  /**
   * 记录分析结果
   */
  private logAnalysisResult(result: AICodeAnalysisResult): void {
    console.log('📈 [AI_CODE_ANALYSIS_RESULT]', {
      timestamp: Date.now(),
      summary: {
        totalDeletedLines: result.totalDeletedLines,
        totalModifiedLines: result.totalModifiedLines,
        totalInsertedLines: result.totalInsertedLines,
        operationsCount: result.operations.length,
        matchedChangeId: result.matchedChangeId
      },
      operations: result.operations.map(op => ({
        type: op.type,
        lines: op.linesCount,
        file: op.file,
        preview: op.content.substring(0, 50) + (op.content.length > 50 ? '...' : '')
      }))
    });

    // 如果有删除或修改操作，特别标记
    if (result.totalDeletedLines > 0 || result.totalModifiedLines > 0) {
      console.log('🚨 [AI_CODE_DELETION_DETECTED]', {
        deletedLines: result.totalDeletedLines,
        modifiedLines: result.totalModifiedLines,
        message: `AI删除了${result.totalDeletedLines}行代码，修改了${result.totalModifiedLines}行代码`
      });
    }
  }

  /**
   * 获取统计摘要
   */
  getStatsSummary(): {
    recentChangesCount: number;
    windowSize: number;
    oldestChangeAge: number;
  } {
    const now = Date.now();
    const oldestChange = this.recentDocumentChanges[0];

    return {
      recentChangesCount: this.recentDocumentChanges.length,
      windowSize: this.CORRELATION_WINDOW,
      oldestChangeAge: oldestChange ? now - oldestChange.timestamp : 0
    };
  }

  /**
   * 清理过期的变化记录
   */
  cleanup(): void {
    const cutoff = Date.now() - this.CORRELATION_WINDOW;
    const beforeCount = this.recentDocumentChanges.length;
    this.recentDocumentChanges = this.recentDocumentChanges.filter(
      change => change.timestamp >= cutoff
    );
    const afterCount = this.recentDocumentChanges.length;

    if (beforeCount !== afterCount) {
      console.log('🧹 [CLEANUP]', {
        removed: beforeCount - afterCount,
        remaining: afterCount
      });
    }
  }
}
