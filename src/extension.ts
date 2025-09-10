import * as vscode from 'vscode';
import { AICodeAnalyzer } from './core/ai-lens';
import { DocumentMonitor } from './runtime/document-monitor';
import { DashboardWebView } from './ui/dashboard-webview';
import { TimingAnalyzer } from './analysis/timing-analyzer';
import { AILensConfig } from './core/types';

/**
 * AI Lens Extension - 主扩展类
 */
export class AILensExtension {
  private analyzer: AICodeAnalyzer;
  private documentMonitor: DocumentMonitor;
  private dashboard: DashboardWebView | undefined;
  private statusBarItem: vscode.StatusBarItem;
  private timingAnalyzer: TimingAnalyzer;
  private isActive = false;

  constructor (private context: vscode.ExtensionContext) {
    this.analyzer = new AICodeAnalyzer();
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.timingAnalyzer = new TimingAnalyzer();

    this.documentMonitor = new DocumentMonitor(
      (change) => this.handleDocumentChange(change),
      undefined, // onPotentialAICode 已废弃
      (fileName, content, operation) => this.handleAIItemContentInferred(fileName, content, operation),
      (aiItem, result, fileName) => this.handleHashMatchFound(aiItem, result, fileName)
    );
  }

  /**
   * 激活扩展
   */
  async activate(): Promise<void> {
    console.log('AI Lens extension is being activated');

    try {
      // 初始化分析器
      await this.analyzer.initialize();

      // 设置时序分析器
      this.analyzer.setTimingAnalyzer(this.timingAnalyzer);

      // 连接Hash推断引擎：从DocumentMonitor获取引擎并设置到AIAnalyzer
      const hashInferenceEngine = this.documentMonitor.getHashInference();
      console.log('   🔗 Hash inference engine from DocumentMonitor:', hashInferenceEngine ? 'Available' : 'Not Available');

      if (hashInferenceEngine) {
        this.analyzer.setHashInferenceEngine(hashInferenceEngine);
        console.log('   ✅ Hash inference engine connected successfully');
      } else {
        console.log('   ❌ Hash inference engine connection failed');
      }

      // 注册命令
      this.registerCommands();

      // 设置状态栏
      this.setupStatusBar();

      // 检查配置是否自动启动
      const config = this.getConfiguration();
      if (config.autoStart) {
        await this.startMonitoring();
      }

      console.log('AI Lens extension activated successfully');
    } catch (error) {
      const message = `Failed to activate AI Lens: ${error}`;
      console.error(message);
      vscode.window.showErrorMessage(message);
    }
  }

  /**
   * 停用扩展
   */
  deactivate(): void {
    console.log('AI Lens extension is being deactivated');

    this.stopMonitoring();
    this.statusBarItem.dispose();

    if (this.dashboard) {
      this.dashboard.dispose();
    }
  }

  /**
   * 注册所有命令
   */
  private registerCommands(): void {
    const commands = [
      vscode.commands.registerCommand('ailens.openDashboard', () => this.openDashboard()),
      vscode.commands.registerCommand('ailens.startMonitoring', () => this.startMonitoring()),
      vscode.commands.registerCommand('ailens.stopMonitoring', () => this.stopMonitoring()),
      vscode.commands.registerCommand('ailens.showStats', () => this.showStats()),
    ];

    commands.forEach(command => this.context.subscriptions.push(command));
  }

  /**
   * 设置状态栏
   */
  private setupStatusBar(): void {
    this.statusBarItem.command = 'ailens.openDashboard';
    this.statusBarItem.tooltip = 'AI Lens - Click to open dashboard';
    this.updateStatusBar();
    this.statusBarItem.show();

    this.context.subscriptions.push(this.statusBarItem);
  }

  /**
   * 更新状态栏显示
   */
  private updateStatusBar(): void {
    const stats = this.analyzer.getStats();
    const aiGeneratedLines = stats.aiGeneratedLines;

    // 显示AI生成的总代码行数，与dashboard保持一致
    this.statusBarItem.text = `$(robot) AI Lens: ${aiGeneratedLines.toLocaleString()}`;

    if (stats.aiGeneratedLines > 0) {
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  }

  /**
   * 开始监控
   */
  private async startMonitoring(): Promise<void> {
    if (this.isActive) {
      vscode.window.showInformationMessage('AI Lens monitoring is already active');
      return;
    }

    try {
      // 启动数据库监控
      this.analyzer.startMonitoring();

      // 启动文档监控
      this.documentMonitor.start();

      this.isActive = true;

      // 刷新统计数据
      await this.analyzer.refreshStats();
      this.updateStatusBar();

      vscode.window.showInformationMessage('AI Lens monitoring started');
      console.log('AI Lens: Monitoring started');
    } catch (error) {
      const message = `Failed to start AI Lens monitoring: ${error}`;
      console.error(message);
      vscode.window.showErrorMessage(message);
    }
  }

  /**
   * 停止监控
   */
  private stopMonitoring(): void {
    if (!this.isActive) {
      vscode.window.showInformationMessage('AI Lens monitoring is not active');
      return;
    }

    this.analyzer.stopMonitoring();
    this.documentMonitor.stop();
    this.isActive = false;

    this.updateStatusBar();

    vscode.window.showInformationMessage('AI Lens monitoring stopped');
    console.log('AI Lens: Monitoring stopped');
  }

  /**
   * 打开仪表板
   */
  private async openDashboard(): Promise<void> {
    if (!this.dashboard) {
      this.dashboard = new DashboardWebView(this.context, this.analyzer);
    }

    await this.dashboard.show();
  }

  /**
   * 显示统计信息
   */
  private async showStats(): Promise<void> {
    const { stats, analyzerStatus, dbStatus } = await this.analyzer.getFullStatus();

    const message = `
AI Lens Statistics:
• Total Lines: ${stats.totalLines.toLocaleString()}
• AI Generated: ${stats.aiGeneratedLines.toLocaleString()} (${stats.percentage.toFixed(1)}%)
• Tab Completions: ${stats.tabCompletionLines.toLocaleString()}
• Chat Composer: ${stats.composerLines.toLocaleString()}
• Files Analyzed: ${stats.files.size}
• Database Status: ${dbStatus.accessible ? 'Connected' : 'Disconnected'}
• Monitoring: ${analyzerStatus.monitoring ? 'Active' : 'Inactive'}
• Unmatched AI Items: ${analyzerStatus.unmatchedItems || 0}
• Last AI Item Hash: ${analyzerStatus.lastItemHash ? analyzerStatus.lastItemHash.substring(0, 8) + '...' : 'None'}
        `.trim();

    vscode.window.showInformationMessage(message, { modal: true });
  }

  /**
 * 处理文档变化 - 简化为仅记录变化，供hash恢复时使用
 */
  private handleDocumentChange(change: any): void {
    // 记录到代码操作分析器（供hash恢复时查找原始内容）
    if (change.changeId) {
      this.analyzer.recordDocumentChangeForOperationAnalysis(change);
    }
  }



  /**
   * 处理AI项目内容推断 - 新的核心方法
   */
  private async handleAIItemContentInferred(fileName: string, content: string, operation: '+' | '-'): Promise<void> {
    try {
      // 调用AI分析器的方法来处理document change匹配
      await this.analyzer.processDocumentChangeForMatching(fileName, content, operation);

      // 更新状态栏显示
      this.updateStatusBar();
    } catch (error) {
      console.error('Error in handleAIItemContentInferred:', error);
    }
  }

  /**
   * 处理Hash匹配成功事件 - 直接更新AI统计
   */
  private handleHashMatchFound(aiItem: any, result: any, fileName: string): void {
    try {
      console.log(`📊 Hash match found - updating AI stats: ${aiItem.hash} (${result.operation})`);

      // 直接更新AI统计，存储解码后的原始内容
      this.analyzer.updateAIStatsOnHashMatch(aiItem, result, fileName);

      // 更新状态栏显示
      this.updateStatusBar();
    } catch (error) {
      console.error('Error in handleHashMatchFound:', error);
    }
  }

  /**
   * 获取配置
   */
  private getConfiguration(): AILensConfig {
    const config = vscode.workspace.getConfiguration('ailens');

    return {
      autoStart: config.get('autoStart', true),
      showNotifications: config.get('showNotifications', true),
    };
  }

  /**
   * 获取扩展状态
   */
  getStatus(): {
    active: boolean;
    monitoring: boolean;
    analyzer: any;
    documentMonitor: any;
  } {
    return {
      active: this.isActive,
      monitoring: this.documentMonitor.isMonitoring(),
      analyzer: this.analyzer.getStatus(),
      documentMonitor: this.documentMonitor.getStats()
    };
  }
}

// 扩展实例
let extensionInstance: AILensExtension | undefined;

/**
 * 扩展激活入口点
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionInstance = new AILensExtension(context);
  await extensionInstance.activate();
}

/**
 * 扩展停用入口点
 */
export function deactivate(): void {
  if (extensionInstance) {
    extensionInstance.deactivate();
    extensionInstance = undefined;
  }
}
