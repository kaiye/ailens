import * as vscode from 'vscode';
import { AICodeAnalyzer } from '../core/ai-lens';
import { AICodeStats, GitCommitAnalysis } from '../core/types';
import { GitCommitAnalyzer } from '../analysis/git-commit-analyzer';
import { WorkspaceUtils } from '../utils/workspace-utils';
import { FileStatsService } from '../analysis/stats/file-stats';
import { getGitInfo, formatGitUrl } from './helpers/git';

/**
 * AI Lens Dashboard WebView
 */
export class DashboardWebView {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private gitCommitAnalyzer: GitCommitAnalyzer;
  private fileStatsService: FileStatsService;

  constructor (
    private context: vscode.ExtensionContext,
    private analyzer: AICodeAnalyzer
  ) {
    this.gitCommitAnalyzer = new GitCommitAnalyzer(analyzer.getAICodeStorage());
    this.fileStatsService = new FileStatsService(analyzer.getAICodeStorage());
  }

  /**
   * 显示仪表板
   */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // 创建WebView面板
    this.panel = vscode.window.createWebviewPanel(
      'ailens-dashboard',
      'AI Lens Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri]
      }
    );

    // 设置HTML内容
    this.panel.webview.html = await this.getWebviewContent();

    // 处理WebView消息
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      undefined,
      this.disposables
    );

    // 面板关闭时清理
    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables
    );

    // 发送初始数据
    await this.sendInitialData();
  }

  /**
   * 处理来自WebView的消息
   */
  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'getInitialData':
        await this.sendInitialData();
        break;
      case 'refresh':
        await this.sendInitialData();
        break;
      case 'openFile':
        this.openFile(message.fileName);
        break;
      case 'export':
        await this.exportStats();
        break;
    }
  }

  /**
   * 发送初始数据到WebView
   */
  private async sendInitialData(): Promise<void> {
    if (!this.panel) {
      return;
    }

    try {
      // 获取工作区信息
      const workspaceRoot = WorkspaceUtils.getWorkspaceRoot();
      let workspace = null;
      let gitInfo = null;

      if (workspaceRoot) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        gitInfo = await getGitInfo(workspaceRoot);

        workspace = {
          name: workspaceFolders?.[0]?.name || 'Unknown',
          path: workspaceRoot,
          git: gitInfo
        };
      }

      // 获取统计信息
      const { stats, dbStatus } = await this.analyzer.getFullStatus();
      const detailedFileStats = await this.fileStatsService.getDetailedFileStats(workspace?.path);

      // 计算整个项目的总代码行数
      const totalProjectLines = workspace?.path ? await this.calculateTotalProjectLines(workspace.path) : 0;


      // 获取Git提交分析（异步处理，不阻塞主要数据）
      let gitCommitAnalysis: GitCommitAnalysis | null = null;
      if (workspace?.path) {
        try {
          gitCommitAnalysis = await this.gitCommitAnalyzer.analyzeRecentCommits(workspace.path, 3);
        } catch (error) {
          console.error('Git commit analysis failed:', error);
          // 继续执行，不因为git分析失败而影响主要功能
        }
      }

      // 发送数据 (convert Map to Object for JSON serialization)
      const messageData = {
        type: 'initialData',
        data: {
          stats,
          dbStatus,
          workspace,
          detailedFileStats: Object.fromEntries(detailedFileStats),
          gitCommitAnalysis,
          totalProjectLines,
          timestamp: Date.now()
        }
      };

      this.panel.webview.postMessage(messageData);
    } catch (error) {
      console.error('Error sending initial data:', error);
      this.panel.webview.postMessage({
        type: 'error',
        message: `Failed to load data: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  /**
   * 获取Git信息
   */
  // Git helpers moved to ./helpers/git

  /**
   * 计算整个项目的总代码行数
   */
  private async calculateTotalProjectLines(workspaceRoot: string): Promise<number> {
    const fs = require('fs');
    const path = require('path');

    try {
      // 定义要包含的文件扩展名
      const codeFileExtensions = new Set([
        '.js', '.jsx', '.ts', '.tsx',
        '.py', '.java', '.cpp', '.c', '.h', '.hpp',
        '.go', '.rs', '.php', '.rb', '.swift',
        '.vue', '.svelte', '.html', '.css', '.scss', '.less',
        '.json', '.yaml', '.yml', '.xml', '.md'
      ]);

      // 定义要排除的目录
      const excludeDirs = new Set([
        'node_modules', '.git', 'dist', 'build', 'out', '.vscode', 'coverage'
      ]);

      let totalLines = 0;
      let totalFiles = 0;

      if (!fs.existsSync(workspaceRoot)) {
        return 0;
      }

      // 递归遍历目录
      const scanDirectory = (dirPath: string): void => {
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
              // 跳过排除的目录
              if (!excludeDirs.has(entry.name)) {
                scanDirectory(fullPath);
              }
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name);

              // 跳过 .min.* 和 .d.ts 文件
              if (entry.name.includes('.min.') || entry.name.endsWith('.d.ts')) {
                continue;
              }

              // 检查是否是代码文件
              if (codeFileExtensions.has(ext)) {
                try {
                  const content = fs.readFileSync(fullPath, 'utf8');
                  const lines = content.split('\n').length;
                  totalLines += lines;
                  totalFiles++;
                } catch (error) {
                  // 跳过无法读取的文件
                }
              }
            }
          }
        } catch (error) {
          // 跳过无法扫描的目录
        }
      };

      scanDirectory(workspaceRoot);

      return totalLines;
    } catch (error) {
      console.error('Failed to calculate total project lines:', error);
      return 0;
    }
  }

  /**
   * 打开文件
   */
  private async openFile(fileName: string): Promise<void> {
    try {
      const path = require('path');
      // 如果是相对路径，需要转换为绝对路径
      let filePath = fileName;
      if (!path.isAbsolute(fileName)) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          filePath = path.join(workspaceFolders[0].uri.fsPath, fileName);
        }
      }

      const document = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open file: ${fileName}`);
    }
  }

  /**
   * 导出统计信息
   */
  private async exportStats(): Promise<void> {
    try {
      const stats = this.analyzer.getStats();
      const detailedFileStats = await this.fileStatsService.getDetailedFileStats();

      const exportData = {
        summary: stats,
        fileDetails: Object.fromEntries(detailedFileStats),
        exportTime: new Date().toISOString()
      };

      const jsonString = JSON.stringify(exportData, null, 2);

      // Show save dialog
      const uri = await vscode.window.showSaveDialog({
        filters: {
          'JSON Files': ['json']
        },
        defaultUri: vscode.Uri.file('ai-lens-stats.json')
      });

      if (uri) {
        const fs = require('fs');
        fs.writeFileSync(uri.fsPath, jsonString, 'utf8');
        vscode.window.showInformationMessage(`Stats exported to ${uri.fsPath}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 获取WebView HTML内容
   */
  private async getWebviewContent(): Promise<string> {
    const fs = require('fs');
    const path = require('path');

    try {
      // 在未打包与打包（esbuild）两种布局下解析路径
      const tryPaths = (rel: string[]) => {
        const candidates = [
          path.join(__dirname, 'webview', ...rel),            // bundled: out/webview
          path.join(__dirname, '..', 'webview', ...rel),       // tsc: out/<module>/../webview
          path.join(__dirname, '..', '..', 'out', 'webview', ...rel), // fallback
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) return p;
        }
        return candidates[0];
      };

      const htmlPath = tryPaths(['dashboard.html']);
      let htmlContent = fs.readFileSync(htmlPath, 'utf8');

      // 读取JavaScript文件
      const jsPath = tryPaths(['dashboard.js']);
      const jsContent = fs.readFileSync(jsPath, 'utf8');

      // 读取图标文件并转换为base64
      const iconPath = tryPaths(['assets', 'icon.png']);
      let iconDataUrl = '';
      try {
        const iconBuffer = fs.readFileSync(iconPath);
        iconDataUrl = `data:image/png;base64,${iconBuffer.toString('base64')}`;
      } catch (iconError) {
        console.warn('Failed to load icon:', iconError);
        iconDataUrl = '';
      }

      // 替换script src为内联JavaScript
      htmlContent = htmlContent.replace('<script src="dashboard.js"></script>', `<script>${jsContent}</script>`);

      // 替换图标占位符
      htmlContent = htmlContent.replace('{{ICON_DATA_URL}}', iconDataUrl);

      return htmlContent;
    } catch (error) {
      console.error('Failed to load dashboard files:', error);
      // Return a simple test HTML to debug JavaScript execution
      return `<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
</head>
<body>
  <h1>Debug Mode</h1>
  <p>Testing JavaScript execution...</p>
  <script>
    console.log('🔥 [DEBUG] Simple JavaScript test!');
    document.body.innerHTML += '<p>JavaScript is working!</p>';
    if (typeof acquireVsCodeApi !== 'undefined') {
      console.log('🔥 [DEBUG] VS Code API is available');
      const vscode = acquireVsCodeApi();
      vscode.postMessage({ type: 'test', message: 'Hello from WebView' });
    } else {
      console.log('🔥 [DEBUG] VS Code API NOT available');
    }
  </script>
</body>
</html>`;
    }
  }

  /**
   * 销毁WebView
   */
  dispose(): void {
    this.panel = undefined;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
