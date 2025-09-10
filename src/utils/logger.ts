import * as vscode from 'vscode';

export class Logger {
  private static cachedDebug: boolean | null = null;
  private static lastCheck = 0;
  private static readonly CHECK_INTERVAL = 5000; // re-check every 5s

  private static isDebugEnabled(): boolean {
    const now = Date.now();
    if (Logger.cachedDebug === null || now - Logger.lastCheck > Logger.CHECK_INTERVAL) {
      try {
        Logger.cachedDebug = vscode.workspace.getConfiguration('ailens').get<boolean>('debug', false) === true;
      } catch {
        Logger.cachedDebug = false;
      }
      Logger.lastCheck = now;
    }
    return Logger.cachedDebug;
  }

  static debug(...args: any[]): void {
    if (Logger.isDebugEnabled()) {
      console.log(...args);
    }
  }

  static info(...args: any[]): void {
    console.log(...args);
  }

  static warn(...args: any[]): void {
    console.warn(...args);
  }

  static error(...args: any[]): void {
    console.error(...args);
  }
}

