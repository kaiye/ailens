/**
 * 时序分析器 - 用于分析文档变化和AI事件的时序关系
 */

interface TimingEvent {
  type: 'document_change' | 'ai_item' | 'hash_match';
  timestamp: number;
  file: string;
  data: any;
  id: string;
}

export class TimingAnalyzer {
  private events: TimingEvent[] = [];
  private readonly MAX_EVENTS = 1000;
  private readonly CORRELATION_WINDOW = 5000; // 5秒窗口

  /**
   * 记录文档变化事件
   */
  recordDocumentChange(file: string, change: any): void {
    const event: TimingEvent = {
      type: 'document_change',
      timestamp: Date.now(),
      file,
      data: {
        textLength: change.text?.length || 0,
        rangeLength: change.rangeLength || 0,
        operation: this.getOperationType(change),
        content: change.text?.substring(0, 100) || '',
        position: change.range
      },
      id: `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };

    this.addEvent(event);
    this.analyzeCorrelations(event);
  }

  /**
   * 记录AI项事件
   */
  recordAIItem(item: any): void {
    const event: TimingEvent = {
      type: 'ai_item',
      timestamp: Date.now(),
      file: item.metadata.fileName,
      data: {
        hash: item.hash,
        source: item.metadata.source,
        originalTimestamp: item.metadata.timestamp,
        age: Date.now() - item.metadata.timestamp
      },
      id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };

    this.addEvent(event);
    this.analyzeCorrelations(event);
  }

  /**
   * 记录哈希匹配事件
   */
  recordHashMatch(file: string, hash: string, content: string): void {
    const event: TimingEvent = {
      type: 'hash_match',
      timestamp: Date.now(),
      file,
      data: {
        hash,
        content: content.substring(0, 100),
        confidence: 'HIGH'
      },
      id: `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };

    this.addEvent(event);
    this.analyzeCorrelations(event);
  }

  /**
   * 分析事件关联性
   */
  private analyzeCorrelations(newEvent: TimingEvent): void {
    const now = newEvent.timestamp;
    const windowStart = now - this.CORRELATION_WINDOW;

    // 查找时间窗口内的相关事件
    const relatedEvents = this.events.filter(event =>
      event.timestamp >= windowStart &&
      event.timestamp <= now &&
      event.file === newEvent.file &&
      event.id !== newEvent.id
    );

    if (relatedEvents.length > 0) {
      this.logCorrelation(newEvent, relatedEvents);
    }
  }

  /**
   * 记录关联性分析
   */
  private logCorrelation(newEvent: TimingEvent, relatedEvents: TimingEvent[]): void {
    const correlations = relatedEvents.map(event => ({
      type: event.type,
      timeDiff: newEvent.timestamp - event.timestamp,
      data: event.data
    }));

    console.log('🔗 [TIMING_CORRELATION]', {
      newEvent: {
        type: newEvent.type,
        timestamp: this.safeFormatTimestamp(newEvent.timestamp),
        file: newEvent.file
      },
      correlatedEvents: correlations,
      analysis: {
        hasDocumentChange: correlations.some(c => c.type === 'document_change'),
        hasAIItem: correlations.some(c => c.type === 'ai_item'),
        hasHashMatch: correlations.some(c => c.type === 'hash_match'),
        maxTimeDiff: Math.max(...correlations.map(c => c.timeDiff)),
        minTimeDiff: Math.min(...correlations.map(c => c.timeDiff)),
        eventCount: correlations.length,
        isHighConfidenceAI: this.isHighConfidenceAI(newEvent, correlations)
      }
    });

    // 如果发现高置信度的AI事件序列，特别标记
    if (this.isHighConfidenceAI(newEvent, correlations)) {
      console.log('🚨 [HIGH_CONFIDENCE_AI_SEQUENCE]', {
        timestamp: Date.now(),
        file: newEvent.file,
        sequence: [newEvent, ...relatedEvents].map(e => ({
          type: e.type,
          timestamp: this.safeFormatTimestamp(e.timestamp),
          data: e.data
        })),
        confidence: this.calculateConfidence(newEvent, correlations)
      });
    }
  }

  /**
   * 判断是否为高置信度AI事件
   */
  private isHighConfidenceAI(newEvent: TimingEvent, correlations: any[]): boolean {
    // 如果在短时间内有文档变化 + AI项目 + 哈希匹配，认为是高置信度
    const hasDoc = correlations.some(c => c.type === 'document_change' && c.timeDiff < 2000);
    const hasAI = correlations.some(c => c.type === 'ai_item' && c.timeDiff < 2000);
    const hasMatch = correlations.some(c => c.type === 'hash_match' && c.timeDiff < 2000);

    return (hasDoc && hasAI) || (hasDoc && hasMatch) || (hasAI && hasMatch);
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(newEvent: TimingEvent, correlations: any[]): number {
    let confidence = 0;

    // 基础分数
    confidence += 30;

    // 时间窗口内的相关事件
    correlations.forEach(corr => {
      if (corr.timeDiff < 1000) confidence += 25; // 1秒内 +25
      else if (corr.timeDiff < 2000) confidence += 15; // 2秒内 +15
      else confidence += 5; // 其他 +5
    });

    // 事件类型组合
    const types = correlations.map(c => c.type);
    if (types.includes('document_change') && types.includes('ai_item')) confidence += 20;
    if (types.includes('hash_match')) confidence += 15;

    return Math.min(confidence, 100);
  }

  /**
   * 添加事件到队列
   */
  private addEvent(event: TimingEvent): void {
    this.events.push(event);

    // 保持队列大小
    if (this.events.length > this.MAX_EVENTS) {
      this.events.splice(0, this.events.length - this.MAX_EVENTS);
    }
  }

  /**
   * 获取操作类型
   */
  private getOperationType(change: any): string {
    const textLength = change.text?.length || 0;
    const rangeLength = change.rangeLength || 0;

    if (textLength > 0 && rangeLength === 0) return 'INSERT';
    if (textLength === 0 && rangeLength > 0) return 'DELETE';
    if (textLength > 0 && rangeLength > 0) return 'REPLACE';
    return 'UNKNOWN';
  }

  /**
   * 获取最近的事件统计
   */
  getRecentStats(timeWindow: number = 30000): {
    totalEvents: number;
    documentChanges: number;
    aiItems: number;
    hashMatches: number;
    correlatedSequences: number;
  } {
    const now = Date.now();
    const cutoff = now - timeWindow;
    const recentEvents = this.events.filter(e => e.timestamp >= cutoff);

    return {
      totalEvents: recentEvents.length,
      documentChanges: recentEvents.filter(e => e.type === 'document_change').length,
      aiItems: recentEvents.filter(e => e.type === 'ai_item').length,
      hashMatches: recentEvents.filter(e => e.type === 'hash_match').length,
      correlatedSequences: this.countCorrelatedSequences(recentEvents)
    };
  }

  /**
   * 计算关联序列数量
   */
  private countCorrelatedSequences(events: TimingEvent[]): number {
    // 简化实现：计算有多少个文件在短时间内有多种类型的事件
    const fileGroups = new Map<string, TimingEvent[]>();

    events.forEach(event => {
      if (!fileGroups.has(event.file)) {
        fileGroups.set(event.file, []);
      }
      fileGroups.get(event.file)!.push(event);
    });

    let correlatedCount = 0;
    fileGroups.forEach(fileEvents => {
      const types = new Set(fileEvents.map(e => e.type));
      if (types.size >= 2) { // 至少有两种不同类型的事件
        correlatedCount++;
      }
    });

    return correlatedCount;
  }

  /**
   * 安全格式化时间戳
   */
  private safeFormatTimestamp(timestamp: number): string {
    try {
      if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp <= 0) {
        return '[Invalid timestamp]';
      }
      return new Date(timestamp).toISOString();
    } catch (error) {
      return `[Error formatting timestamp: ${timestamp}]`;
    }
  }

  /**
   * 清理旧事件
   */
  cleanup(maxAge: number = 300000): void { // 5分钟
    const cutoff = Date.now() - maxAge;
    this.events = this.events.filter(e => e.timestamp >= cutoff);
  }
}
