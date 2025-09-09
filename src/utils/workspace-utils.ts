import * as vscode from 'vscode';
import * as path from 'path';

/**
 * 工作区相关的工具函数
 */
export class WorkspaceUtils {
  /**
   * 获取工作区根目录
   */
  static getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].uri.fsPath;
    }
    return undefined;
  }

  /**
   * 获取相对文件名
   */
  static getRelativeFileName(filePath: string): string {
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
   * 计算工作区总代码行数
   */
  static async calculateTotalLines(): Promise<{
    totalLines: number;
    fileStats: Map<string, { totalLines: number; aiLines: number; percentage: number }>;
  }> {
    const fileStats = new Map<string, { totalLines: number; aiLines: number; percentage: number }>();

    try {
      const files = await vscode.workspace.findFiles(
        '**/*.{ts,js,tsx,jsx,py,java,cpp,c,cs,php,rb,go,rs,swift,kt}',
        '**/node_modules/**'
      );

      let totalLines = 0;

      for (const file of files) {
        try {
          const document = await vscode.workspace.openTextDocument(file);
          const fileName = this.getRelativeFileName(file.fsPath);
          const fileLineCount = document.lineCount;

          totalLines += fileLineCount;

          // 创建文件统计
          fileStats.set(fileName, {
            totalLines: fileLineCount,
            aiLines: 0,
            percentage: 0
          });
        } catch (error) {
          console.warn(`Failed to read file ${file.fsPath}:`, error);
        }
      }

      return { totalLines, fileStats };
    } catch (error) {
      console.error('Failed to calculate total lines:', error);
      return { totalLines: 0, fileStats };
    }
  }

  /**
   * 检查文件是否在当前工作区内
   */
  static isFileInWorkspace(filePath: string): boolean {
    const workspaceRoot = this.getWorkspaceRoot();
    return workspaceRoot ? filePath.startsWith(workspaceRoot) : false;
  }

  /**
   * 将绝对路径转换为相对路径
   */
  static toRelativePath(absolutePath: string): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot || !absolutePath.startsWith(workspaceRoot)) {
      return absolutePath;
    }
    return path.relative(workspaceRoot, absolutePath);
  }
}
