import * as vscode from 'vscode';
import { DocumentChange } from '../core/types';
import { LineBasedHashInference } from '../hashing/line-inference';
import { DocumentVersionHistory } from './document-version-history';
import { Logger } from '../utils/logger';
import { buildDeleteRecords, buildInsertRecords, buildReplaceRecords } from './line-capture';

/**
 * VS Code document monitor for tracking text changes
 * 新版本：专注于捕获完整行内容，支持精确的AI Hash推断
 */
export class DocumentMonitor {
  private disposables: vscode.Disposable[] = [];
  private isActive = false;

  // 缓存最近的文档变化，用于匹配AI生成的代码
  private recentChanges: Map<string, DocumentChange[]> = new Map();
  private readonly CHANGE_RETENTION_TIME = 300000; // 300秒

  // 新的推断引擎
  private hashInference: LineBasedHashInference;
  private versionHistory: DocumentVersionHistory;

  // 轻量级快照：只保留最近1-2个版本的关键内容
  private documentSnapshots = new Map<string, {
    version: number;
    timestamp: number;
    lineContents: string[]; // 只存行内容数组，不存完整文档
  }>();
  private readonly MAX_SNAPSHOTS = 500; // ~25MB for 500 files, reasonable for large projects
  private readonly SNAPSHOT_CLEANUP_INTERVAL = 3600000; // 1 hour - less aggressive cleanup
  // Cleanup strategy: Always keep at least one snapshot per file
  private lastSnapshotCleanup = Date.now();

  constructor (
    private onCodeChange: (change: DocumentChange) => void,
    private _onPotentialAICode?: (fileName: string, content: string, operation: '+' | '-') => void,
    private _onAIItemContentInferred?: (fileName: string, content: string, operation: '+' | '-') => Promise<void>,
    private onHashMatchFound?: (aiItem: any, result: any, fileName: string) => void
  ) {
    // 初始化新的推断引擎，传递hash match回调
    this.hashInference = new LineBasedHashInference(this.onHashMatchFound);
    this.versionHistory = new DocumentVersionHistory();
  }

  /**
   * 开始监听文档变化
   */
  start(): void {
    if (this.isActive) {
      return;
    }

    this.isActive = true;

    // 监听文档打开事件 - 立即捕获初始快照
    const openDocDisposable = vscode.workspace.onDidOpenTextDocument((document) => {
      this.captureDocumentSnapshot(document, 'onOpen');
    });

    // 监听编辑器激活事件 - 确保有快照
    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document) {
        this.ensureSnapshotExists(editor.document, 'onActive');
      }
    });

    // 监听文档内容变化 - 关键事件
    const textChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      // 立即处理变化，这时获取原始内容
      this.handleTextDocumentChangeWithPreSnapshot(event);
    });

    this.disposables.push(
      openDocDisposable,
      activeEditorDisposable,
      textChangeDisposable
    );

    // 定期清理过期的变化记录
    const cleanupInterval = setInterval(() => {
      this.cleanupOldChanges();
      this.versionHistory.performMaintenance();
      // 定期清理推断引擎中已使用且过期的记录，避免内存累积
      this.hashInference.cleanup();
    }, 10000); // 每10秒清理一次

    this.disposables.push(new vscode.Disposable(() => {
      clearInterval(cleanupInterval);
    }));

    Logger.info('Document monitor started');
  }

  /**
   * 停止监听文档变化
   */
  stop(): void {
    if (!this.isActive) {
      return;
    }

    this.isActive = false;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.recentChanges.clear();
    this.hashInference.cleanup();
    this.versionHistory.clear();

    Logger.info('Document monitor stopped');
  }

  /**
 * 处理文档内容变化 - 基于完整行内容的新版本
 */
  private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    const fileName = this.getRelativeFileName(document.uri.fsPath);
    const timestamp = Date.now();

    for (const change of event.contentChanges) {
      // 获取变更前的内容
      const beforeText = this.getBeforeText(document, change);
      const afterText = change.text;

      // 确定操作类型
      const operation = this.determineOperation(change.rangeLength, change.text.length);

      // 计算影响的行数
      const affectedLines = this.calculateAffectedLines(change.range, change.text);
      // 生成唯一标识符
      const changeId = `${fileName}_${timestamp}_${Math.random().toString(36).substring(2, 11)}`;

      const documentChange: DocumentChange = {
        document: fileName,
        range: {
          start: {
            line: change.range.start.line,
            character: change.range.start.character
          },
          end: {
            line: change.range.end.line,
            character: change.range.end.character
          }
        },
        rangeLength: change.rangeLength,
        text: change.text,
        timestamp,
        beforeText,
        afterText,
        operation,
        affectedLines,
        changeId
      };

      // 打印详细的文档变化信息
      this.logDocumentChange(documentChange, change);

      // 存储变化记录
      this.storeChange(fileName, documentChange);

      // 通知变化
      this.onCodeChange(documentChange);

      // 新增：基于完整行内容进行推断
      this.captureFullLineContents(document, change, fileName, timestamp);
    }
  }

  /**
 * 详细的文档变化日志 - 用于hash反推调试，输出完全原始信息
 */
  private logDocumentChange(documentChange: DocumentChange, originalChange: any): void {
    const { text } = documentChange;

    // 只记录有意义的变化
    if (text.length > 0) {
      Logger.debug(`\n=== DOCUMENT CHANGE EVENT ===`);
      Logger.debug(`Raw VS Code TextDocumentContentChangeEvent:`, JSON.stringify(originalChange, null, 2));
      Logger.debug(`Processed DocumentChange object:`, JSON.stringify(documentChange, null, 2));

      // 输出所有变化的代码行，不做任何trim操作
      const lines = text.split('\n');
      Logger.debug(`Raw content lines (${lines.length} total):`);
      lines.forEach((line, index) => {
        Logger.debug(`  Raw Line ${index + 1}: ${JSON.stringify(line)}`);
      });

      if (documentChange.beforeText && documentChange.beforeText.length > 0) {
        const beforeLines = documentChange.beforeText.split('\n');
        Logger.debug(`Raw before content lines (${beforeLines.length} total):`);
        beforeLines.forEach((line, index) => {
          Logger.debug(`  Raw Before Line ${index + 1}: ${JSON.stringify(line)}`);
        });
      }
      Logger.debug(`=== END DOCUMENT CHANGE ===\n`);
    }
  }

  /**
   * 捕获完整行内容 - 基于变更类型正确处理单行/多行场景
   */
  private captureFullLineContents(
    document: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent,
    fileName: string,
    timestamp: number
  ): void {
    Logger.debug(`\n🔍 FULL LINE CAPTURE:`);
    Logger.debug(`  Change range: [${change.range.start.line}:${change.range.start.character}, ${change.range.end.line}:${change.range.end.character}]`);
    Logger.debug(`  Range length: ${change.rangeLength}, New text length: ${change.text.length}`);

    const startLine = change.range.start.line;
    const endLine = change.range.end.line;
    const snapshot = this.documentSnapshots.get(fileName);

    // 判断变更类型
    const isDelete = change.rangeLength > 0 && change.text === "";
    const isInsert = change.rangeLength === 0 && change.text.length > 0;
    const isReplace = change.rangeLength > 0 && change.text.length > 0;

    Logger.debug(`  Operation type: ${isDelete ? 'DELETE' : isInsert ? 'INSERT' : isReplace ? 'REPLACE' : 'UNKNOWN'}`);

    if (isDelete) {
      const recs = buildDeleteRecords(snapshot, startLine, endLine, timestamp, fileName);
      recs.forEach(r => this.hashInference.recordLineContent(r));
    } else if (isInsert) {
      const recs = buildInsertRecords(document, change, snapshot, timestamp, fileName);
      recs.forEach(r => this.hashInference.recordLineContent(r));
    } else if (isReplace) {
      const recs = buildReplaceRecords(document, change, snapshot, timestamp, fileName);
      recs.forEach(r => this.hashInference.recordLineContent(r));
    }

    Logger.debug(`🔍 END FULL LINE CAPTURE\n`);
  }

  /**
   * 处理删除操作 - 只生成 - records
   */
  // moved to line-capture helpers

  /**
   * 处理插入操作 - 生成原始行的 - record 和新行的 + records
   */
  // moved to line-capture helpers

  /**
   * 处理替换操作 - 生成被替换行的 - records 和新内容的 + records
   */
  // moved to line-capture helpers

  /**
   * 获取受影响的行号
   */
  private getAffectedLineNumbers(range: vscode.Range, insertedText: string): number[] {
    const startLine = range.start.line;
    const endLine = range.end.line;
    const insertedLines = insertedText.split('\n').length - 1;

    const affectedLines: number[] = [];

    // 原有的受影响行
    for (let i = startLine; i <= endLine; i++) {
      affectedLines.push(i);
    }

    // 新插入的行
    for (let i = 1; i <= insertedLines; i++) {
      affectedLines.push(startLine + i);
    }

    return [...new Set(affectedLines)]; // 去重
  }

  /**
   * 处理文档保存
   */
  private handleDocumentSave(document: vscode.TextDocument): void {
    const fileName = this.getRelativeFileName(document.uri.fsPath);
    // console.log(`Document saved: ${fileName}`);
  }

  /**
   * 处理文档打开
   */
  private handleDocumentOpen(document: vscode.TextDocument): void {
    const fileName = this.getRelativeFileName(document.uri.fsPath);
    // console.log(`Document opened: ${fileName}`);
  }

  /**
   * 存储文档变化记录
   */
  private storeChange(fileName: string, change: DocumentChange): void {
    if (!this.recentChanges.has(fileName)) {
      this.recentChanges.set(fileName, []);
    }

    const changes = this.recentChanges.get(fileName)!;
    changes.push(change);

    // 限制每个文件的变化记录数量
    if (changes.length > 100) {
      changes.splice(0, changes.length - 100);
    }
  }

  /**
 * 获取变更前的文档内容
 */
  private getBeforeText(document: vscode.TextDocument, change: vscode.TextDocumentContentChangeEvent): string {
    try {
      if (change.rangeLength > 0) {
        // 如果有内容被删除或替换，我们可以从文档中重构原始内容
        // 注意：这里获取的是变更后的文档状态，所以需要重构变更前的内容
        const currentText = document.getText(change.range);

        if (change.text.length === 0) {
          // 纯删除操作：变更前的内容应该是被删除的内容
          // 由于我们无法直接获取被删除的内容，返回空字符串
          return '';
        } else if (change.rangeLength > 0) {
          // 替换操作：尝试推断原始内容
          // 这是一个限制，VS Code API 不提供变更前的原始内容
          return `[原始内容已被替换，长度:${change.rangeLength}]`;
        }
      }
      return '';
    } catch (error) {
      return `[获取原始内容失败: ${error}]`;
    }
  }

  /**
   * 确定操作类型
   */
  private determineOperation(rangeLength: number, textLength: number): 'insert' | 'delete' | 'replace' {
    if (textLength > 0 && rangeLength === 0) {
      return 'insert';
    } else if (textLength === 0 && rangeLength > 0) {
      return 'delete';
    } else if (textLength > 0 && rangeLength > 0) {
      return 'replace';
    }
    return 'insert'; // 默认值
  }

  /**
   * 计算影响的行数
   */
  private calculateAffectedLines(range: vscode.Range, newText: string): number {
    const startLine = range.start.line;
    const endLine = range.end.line;
    const rangeLines = endLine - startLine + 1;
    const newLines = newText.split('\n').length;

    return Math.max(rangeLines, newLines);
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
   * 清理过期的变化记录
   */
  private cleanupOldChanges(): void {
    const now = Date.now();
    const cutoff = now - this.CHANGE_RETENTION_TIME;

    for (const [fileName, changes] of this.recentChanges.entries()) {
      const validChanges = changes.filter(change => change.timestamp > cutoff);

      if (validChanges.length === 0) {
        this.recentChanges.delete(fileName);
      } else {
        this.recentChanges.set(fileName, validChanges);
      }
    }
  }

  /**
   * 获取指定文件的最近变化
   */
  getRecentChanges(fileName: string, maxAge: number = this.CHANGE_RETENTION_TIME): DocumentChange[] {
    const changes = this.recentChanges.get(fileName) || [];
    const cutoff = Date.now() - maxAge;

    return changes.filter(change => change.timestamp > cutoff);
  }

  /**
   * 获取监听状态
   */
  isMonitoring(): boolean {
    return this.isActive;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    isActive: boolean;
    filesBeingWatched: number;
    totalChanges: number;
  } {
    let totalChanges = 0;
    for (const changes of this.recentChanges.values()) {
      totalChanges += changes.length;
    }

    return {
      isActive: this.isActive,
      filesBeingWatched: this.recentChanges.size,
      totalChanges
    };
  }

  /**
   * 获取Hash推断引擎的统计信息
   */
  getHashInferenceStats() {
    return this.hashInference.getStats();
  }

  /**
   * 获取版本历史的统计信息
   */
  getVersionHistoryStats() {
    return this.versionHistory.getStats();
  }

  /**
   * 获取Hash推断引擎实例（供外部使用）
   */
  getHashInference(): LineBasedHashInference {
    return this.hashInference;
  }

  /**
   * 捕获文档快照（轻量级，只存行内容）
   */
  private captureDocumentSnapshot(document: vscode.TextDocument, trigger: string): void {
    const fileName = this.getRelativeFileName(document.uri.fsPath);
    const lines = document.getText().split('\n');

    Logger.debug(`📸 Capturing snapshot: ${fileName} (${trigger}, ${lines.length} lines)`);

    this.documentSnapshots.set(fileName, {
      version: document.version,
      timestamp: Date.now(),
      lineContents: lines
    });

    // 清理逻辑：控制总快照数量防止内存泄漏
    this.cleanupSnapshotsIfNeeded();
  }

  /**
   * 确保文档存在快照
   */
  private ensureSnapshotExists(document: vscode.TextDocument, trigger: string): void {
    const fileName = this.getRelativeFileName(document.uri.fsPath);
    const existing = this.documentSnapshots.get(fileName);

    if (!existing || existing.version < document.version) {
      this.captureDocumentSnapshot(document, trigger);
    }
  }

  /**
   * 处理文档变更事件（带预快照）
   */
  private handleTextDocumentChangeWithPreSnapshot(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    const fileName = this.getRelativeFileName(document.uri.fsPath);

    Logger.debug(`\n🔄 Document change detected: ${fileName}`);
    Logger.debug(`   Document version: ${document.version}`);
    Logger.debug(`   Changes count: ${event.contentChanges.length}`);

    // 尝试获取变更前的内容
    const snapshot = this.documentSnapshots.get(fileName);

    // 处理每个变更
    for (let i = 0; i < event.contentChanges.length; i++) {
      const change = event.contentChanges[i];
      Logger.debug(`\n📝 Processing change ${i + 1}:`);

      // 尝试从快照获取原始内容
      const originalContent = this.getOriginalContentFromSnapshot(snapshot, change);

      Logger.debug(`   Range: [${change.range.start.line}:${change.range.start.character}, ${change.range.end.line}:${change.range.end.character}]`);
      Logger.debug(`   Range length: ${change.rangeLength}`);
      Logger.debug(`   New text: "${change.text}"`);
      Logger.debug(`   Original content: "${originalContent}"`);

      // 继续处理原有逻辑
      this.handleSingleTextChange(document, change, originalContent);
    }

    // 更新快照到最新版本
    this.captureDocumentSnapshot(document, 'postChange');
  }

  /**
   * 从快照中获取原始内容
   */
  private getOriginalContentFromSnapshot(
    snapshot: { version: number, timestamp: number, lineContents: string[] } | undefined,
    change: vscode.TextDocumentContentChangeEvent
  ): string {
    if (!snapshot) {
      return '[no snapshot available]';
    }

    try {
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      const startChar = change.range.start.character;
      const endChar = change.range.end.character;

      if (startLine === endLine) {
        // 单行变更
        const originalLine = snapshot.lineContents[startLine] || '';
        if (change.rangeLength === 0) {
          // 插入操作，原始位置为空
          return '';
        } else {
          // 删除或替换操作，提取被影响的部分
          return originalLine.substring(startChar, startChar + change.rangeLength);
        }
      } else {
        // 多行变更
        const affectedLines = snapshot.lineContents.slice(startLine, endLine + 1);
        if (affectedLines.length === 0) return '';

        // 构建原始的被替换内容
        let originalContent = '';
        for (let i = 0; i < affectedLines.length; i++) {
          const line = affectedLines[i] || '';
          if (i === 0) {
            // 第一行：从startChar开始
            originalContent += line.substring(startChar);
          } else if (i === affectedLines.length - 1) {
            // 最后一行：到endChar结束
            originalContent += '\n' + line.substring(0, endChar);
          } else {
            // 中间行：整行
            originalContent += '\n' + line;
          }
        }
        return originalContent;
      }
    } catch (error) {
      return `[error extracting: ${error}]`;
    }
  }

  /**
   * 处理单个文本变更
   */
  private handleSingleTextChange(
    document: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent,
    _originalContent: string
  ): void {
    // 调用captureFullLineContents方法处理+/-记录创建
    const fileName = this.getRelativeFileName(document.uri.fsPath);
    this.captureFullLineContents(document, change, fileName, Date.now());
  }


  /**
   * 清理快照以防止内存泄漏
   */
  private cleanupSnapshotsIfNeeded(): void {
    const now = Date.now();
    
    // 定期清理或达到数量限制时清理
    if (now - this.lastSnapshotCleanup > this.SNAPSHOT_CLEANUP_INTERVAL || 
        this.documentSnapshots.size > this.MAX_SNAPSHOTS) {
      
      // 收集所有快照，按文件分组
      const fileGroups = new Map<string, typeof snapshots[0][]>();
      const snapshots = Array.from(this.documentSnapshots.entries())
        .map(([fileName, snapshot]) => ({ fileName, ...snapshot }));
      
      // 按文件分组
      snapshots.forEach(snapshot => {
        const group = fileGroups.get(snapshot.fileName) || [];
        group.push(snapshot);
        fileGroups.set(snapshot.fileName, group);
      });
      
      // 为每个文件至少保留一个最新的快照，然后按时间排序保留其余的
      const toKeep: typeof snapshots = [];
      
      // 每个文件保留最新的一个
      fileGroups.forEach(group => {
        group.sort((a, b) => b.timestamp - a.timestamp);
        toKeep.push(group[0]); // 最新的一个
      });
      
      // 如果还有空间，按时间顺序添加其余快照
      const remainingSlots = this.MAX_SNAPSHOTS - toKeep.length;
      if (remainingSlots > 0) {
        const additionalSnapshots = snapshots
          .filter(s => !toKeep.some(k => k.fileName === s.fileName && k.timestamp === s.timestamp))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, remainingSlots);
        toKeep.push(...additionalSnapshots);
      }
      
      // 清空并重新填充
      this.documentSnapshots.clear();
      toKeep.forEach(snapshot => {
        this.documentSnapshots.set(snapshot.fileName, {
          version: snapshot.version,
          timestamp: snapshot.timestamp,
          lineContents: snapshot.lineContents
        });
      });
      
      const uniqueFiles = new Set(toKeep.map(s => s.fileName)).size;
      console.log(`🧹 [CLEANUP] Cleaned document snapshots: ${snapshots.length} → ${this.documentSnapshots.size} (${uniqueFiles} files preserved)`);
      this.lastSnapshotCleanup = now;
    }
  }
}
