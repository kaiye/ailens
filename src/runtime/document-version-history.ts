import * as vscode from 'vscode';

/**
 * 文档快照
 */
export interface DocumentSnapshot {
  version: number;
  timestamp: number;
  lineCount: number;
  lines: string[];
}

/**
 * 删除内容信息
 */
export interface DeletedContent {
  content: string;
  startLine: number;
  endLine: number;
  startCharacter: number;
  endCharacter: number;
}

/**
 * 文档版本历史跟踪器
 * 用于重构被删除的内容，支持 AI Hash 的 - 操作推断
 */
export class DocumentVersionHistory {
  private histories: Map<string, DocumentSnapshot[]> = new Map();
  private readonly MAX_VERSIONS_PER_FILE = 50; // 每个文件最多保存50个版本
  private readonly MAX_HISTORY_TIME = 10 * 60 * 1000; // 保存10分钟历史

  /**
   * 记录文档版本快照
   */
  recordSnapshot(document: vscode.TextDocument): void {
    const fileName = this.getRelativeFileName(document.uri.fsPath);
    const timestamp = Date.now();
    
    // 获取所有行内容
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }

    const snapshot: DocumentSnapshot = {
      version: document.version,
      timestamp,
      lineCount: document.lineCount,
      lines: [...lines] // 深拷贝
    };

    // 存储快照
    if (!this.histories.has(fileName)) {
      this.histories.set(fileName, []);
    }

    const fileHistory = this.histories.get(fileName)!;
    fileHistory.push(snapshot);

    // 限制版本数量
    if (fileHistory.length > this.MAX_VERSIONS_PER_FILE) {
      fileHistory.splice(0, fileHistory.length - this.MAX_VERSIONS_PER_FILE);
    }

    // 清理过期版本
    this.cleanupOldVersions(fileName);
  }

  /**
   * 获取被删除的内容
   */
  getDeletedContent(fileName: string, range: vscode.Range, beforeVersion: number): DeletedContent | null {
    const fileHistory = this.histories.get(fileName);
    if (!fileHistory) {
      return null;
    }

    // 查找指定版本的快照
    const snapshot = fileHistory.find(s => s.version === beforeVersion);
    if (!snapshot) {
      // 如果找不到确切版本，尝试找最接近的较早版本
      const closestSnapshot = fileHistory
        .filter(s => s.version < beforeVersion)
        .sort((a, b) => b.version - a.version)[0];
      
      if (!closestSnapshot) {
        return null;
      }
      
      return this.extractDeletedContent(closestSnapshot, range);
    }

    return this.extractDeletedContent(snapshot, range);
  }

  /**
   * 从快照中提取被删除的内容
   */
  private extractDeletedContent(snapshot: DocumentSnapshot, range: vscode.Range): DeletedContent | null {
    try {
      const startLine = range.start.line;
      const endLine = range.end.line;
      const startChar = range.start.character;
      const endChar = range.end.character;

      // 检查范围是否有效
      if (startLine >= snapshot.lines.length || endLine >= snapshot.lines.length) {
        return null;
      }

      let deletedContent = '';

      if (startLine === endLine) {
        // 同行删除
        const line = snapshot.lines[startLine];
        if (startChar >= line.length || endChar > line.length) {
          return null;
        }
        deletedContent = line.substring(startChar, endChar);
      } else {
        // 跨行删除
        // 第一行：从 startChar 到行尾
        const firstLine = snapshot.lines[startLine];
        if (startChar < firstLine.length) {
          deletedContent += firstLine.substring(startChar);
        }

        // 中间行：完整行
        for (let i = startLine + 1; i < endLine; i++) {
          deletedContent += '\n' + snapshot.lines[i];
        }

        // 最后一行：从行首到 endChar
        if (endLine < snapshot.lines.length) {
          const lastLine = snapshot.lines[endLine];
          if (endChar <= lastLine.length) {
            deletedContent += '\n' + lastLine.substring(0, endChar);
          }
        }
      }

      return {
        content: deletedContent,
        startLine,
        endLine,
        startCharacter: startChar,
        endCharacter: endChar
      };

    } catch (error) {
      console.error('Error extracting deleted content:', error);
      return null;
    }
  }

  /**
   * 基于范围和当前文档状态推断删除内容
   */
  inferDeletedContentFromChange(
    document: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent
  ): DeletedContent | null {
    // 如果是删除操作（rangeLength > 0, text === ''）
    if (change.rangeLength > 0 && change.text === '') {
      // 尝试从版本历史中获取删除的内容
      const fileName = this.getRelativeFileName(document.uri.fsPath);
      const deletedContent = this.getDeletedContent(fileName, change.range, document.version - 1);
      
      if (deletedContent) {
        return deletedContent;
      }

      // 如果没有历史版本，尝试其他方法推断
      return this.estimateDeletedContent(change.range, change.rangeLength);
    }

    return null;
  }

  /**
   * 估算被删除的内容（当没有历史版本时）
   */
  private estimateDeletedContent(range: vscode.Range, rangeLength: number): DeletedContent {
    // 生成占位符内容，用于hash尝试匹配
    const estimatedContent = `[deleted:${rangeLength}chars]`;
    
    return {
      content: estimatedContent,
      startLine: range.start.line,
      endLine: range.end.line,
      startCharacter: range.start.character,
      endCharacter: range.end.character
    };
  }

  /**
   * 获取文件的最新快照
   */
  getLatestSnapshot(fileName: string): DocumentSnapshot | null {
    const fileHistory = this.histories.get(fileName);
    if (!fileHistory || fileHistory.length === 0) {
      return null;
    }
    
    return fileHistory[fileHistory.length - 1];
  }

  /**
   * 获取指定版本的快照
   */
  getSnapshot(fileName: string, version: number): DocumentSnapshot | null {
    const fileHistory = this.histories.get(fileName);
    if (!fileHistory) {
      return null;
    }
    
    return fileHistory.find(s => s.version === version) || null;
  }

  /**
   * 获取文件的所有历史版本信息
   */
  getFileHistory(fileName: string): DocumentSnapshot[] {
    return this.histories.get(fileName) || [];
  }

  /**
   * 清理过期版本
   */
  private cleanupOldVersions(fileName: string): void {
    const fileHistory = this.histories.get(fileName);
    if (!fileHistory) {
      return;
    }

    const cutoffTime = Date.now() - this.MAX_HISTORY_TIME;
    const validVersions = fileHistory.filter(snapshot => snapshot.timestamp >= cutoffTime);
    
    this.histories.set(fileName, validVersions);
  }

  /**
   * 清理所有过期版本
   */
  cleanupAllOldVersions(): void {
    for (const fileName of this.histories.keys()) {
      this.cleanupOldVersions(fileName);
      
      // 如果文件没有有效版本，移除整个记录
      const fileHistory = this.histories.get(fileName);
      if (!fileHistory || fileHistory.length === 0) {
        this.histories.delete(fileName);
      }
    }
  }

  /**
   * 获取相对文件名
   */
  private getRelativeFileName(filePath: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return filePath;
    }

    for (const folder of workspaceFolders) {
      if (filePath.startsWith(folder.uri.fsPath)) {
        return filePath.substring(folder.uri.fsPath.length + 1);
      }
    }

    return filePath;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalFiles: number;
    totalVersions: number;
    oldestTimestamp: number;
    newestTimestamp: number;
    totalMemoryUsage: number;
  } {
    let totalVersions = 0;
    let oldestTimestamp = Date.now();
    let newestTimestamp = 0;
    let totalMemoryUsage = 0;

    for (const fileHistory of this.histories.values()) {
      totalVersions += fileHistory.length;
      
      for (const snapshot of fileHistory) {
        if (snapshot.timestamp < oldestTimestamp) oldestTimestamp = snapshot.timestamp;
        if (snapshot.timestamp > newestTimestamp) newestTimestamp = snapshot.timestamp;
        
        // 估算内存使用量（每行按平均长度估算）
        totalMemoryUsage += snapshot.lines.reduce((sum, line) => sum + line.length * 2, 0); // 2 bytes per character
      }
    }

    return {
      totalFiles: this.histories.size,
      totalVersions,
      oldestTimestamp: this.histories.size > 0 ? oldestTimestamp : 0,
      newestTimestamp: this.histories.size > 0 ? newestTimestamp : 0,
      totalMemoryUsage
    };
  }

  /**
   * 清理所有历史记录
   */
  clear(): void {
    this.histories.clear();
  }

  /**
   * 定期清理任务（建议定时调用）
   */
  performMaintenance(): void {
    this.cleanupAllOldVersions();
    
    // 如果内存使用过多，额外清理
    const stats = this.getStats();
    if (stats.totalMemoryUsage > 100 * 1024 * 1024) { // 100MB
      // 减少保存的版本数量
      for (const [fileName, fileHistory] of this.histories.entries()) {
        if (fileHistory.length > 20) {
          const reducedHistory = fileHistory.slice(-20); // 只保留最近20个版本
          this.histories.set(fileName, reducedHistory);
        }
      }
    }
  }
}
