import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as sqlite3 from 'sqlite3';
import { AICodeItem } from '../../core/types';
import { SmartEventDebouncer } from '../../utils/debounce';

/**
 * 智能 Debounce 事件处理器
 * 复用自 cursor-ai-watcher.js 的 SmartEventDebouncer
 */
// SmartEventDebouncer moved to utils/debounce

/**
 * Database manager for accessing Cursor's SQLite database
 */
export class CursorDatabase {
  private dbPath: string;
  private dbDir: string;
  private dbFileName: string;

  // 智能 Debounce 事件系统
  private dbWatchers = new Map<string, { watcher: fs.FSWatcher; path: string }>();
  private eventDebouncer = new SmartEventDebouncer(300, 2000);
  private currentCallback: (() => void) | null = null;

  // 文件元数据缓存（智能检查机制）
  private fileMetaCache = {
    size: 0,
    mtime: 0,
    lastCheck: 0
  };

  constructor () {
    this.dbPath = this.getCursorDatabasePath();
    this.dbDir = path.dirname(this.dbPath);
    this.dbFileName = path.basename(this.dbPath);
  }

  /**
   * 获取Cursor数据库路径
   */
  private getCursorDatabasePath(): string {
    const platform = os.platform();
    let basePath: string;

    switch (platform) {
      case 'darwin':
        basePath = path.join(os.homedir(), 'Library/Application Support/Cursor');
        break;
      case 'win32':
        basePath = path.join(os.homedir(), 'AppData/Roaming/Cursor');
        break;
      case 'linux':
        basePath = path.join(os.homedir(), '.config/Cursor');
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }

    return path.join(basePath, 'User/globalStorage/state.vscdb');
  }

  /**
   * 检查数据库是否存在且可访问
   */
  isAvailable(): boolean {
    try {
      return fs.existsSync(this.dbPath) && fs.accessSync(this.dbPath, fs.constants.R_OK) === undefined;
    } catch {
      return false;
    }
  }

  /**
   * 获取数据库路径
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * 从数据库加载AI追踪项
   */
  async loadAITrackingItems(): Promise<AICodeItem[] | null> {
    if (!this.isAvailable()) {
      throw new Error(`Cursor database not found or not accessible: ${this.dbPath}`);
    }

    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          reject(new Error(`Failed to open database: ${err.message}`));
          return;
        }
      });

      const query = `
                SELECT key, value 
                FROM ItemTable 
                WHERE key = 'aiCodeTrackingLines'
            `;

      db.get(query, [], (err, row: any) => {
        if (err) {
          db.close();
          reject(new Error(`Database query failed: ${err.message}`));
          return;
        }

        let data: AICodeItem[] | null = null;
        if (row) {
          try {
            data = JSON.parse(row.value) as AICodeItem[];
          } catch (parseErr) {
            db.close();
            reject(new Error(`Failed to parse aiCodeTrackingLines: ${parseErr}`));
            return;
          }
        }

        db.close((closeErr) => {
          if (closeErr) {
            console.warn(`Warning: Failed to close database: ${closeErr.message}`);
          }
        });

        resolve(data);
      });
    });
  }

  /**
   * 获取数据库文件元数据
   */
  private getDatabaseMetadata(): { size: number; mtime: number; exists: boolean } {
    try {
      const stats = fs.statSync(this.dbPath);
      return {
        size: stats.size,
        mtime: stats.mtime.getTime(),
        exists: true
      };
    } catch (error) {
      return {
        size: 0,
        mtime: 0,
        exists: false
      };
    }
  }

  /**
   * 智能检查：基于文件元数据变化的数据库内容检查
   * 结合 debounce 机制，只有文件真正变化时才检查数据库内容
   */
  private async smartCheckForNewItems(): Promise<void> {
    // 1. 元数据检查：文件是否真的有变化
    const currentMeta = this.getDatabaseMetadata();
    if (!currentMeta.exists) {
      return;
    }

    const hasMetadataChanged =
      currentMeta.size !== this.fileMetaCache.size ||
      currentMeta.mtime !== this.fileMetaCache.mtime;

    if (!hasMetadataChanged) {
      return;
    }

    // 3. 更新缓存
    this.fileMetaCache = {
      size: currentMeta.size,
      mtime: currentMeta.mtime,
      lastCheck: Date.now()
    };

    // 4. 执行实际的数据库内容检查
    if (this.currentCallback) {
      this.currentCallback();
    }
  }

  /**
   * 检测 SQLite 工作模式
   */
  private detectSQLiteMode(): { walMode: boolean; journalMode: boolean; shmExists: boolean } {
    const walPath = this.dbPath + '-wal';
    const journalPath = this.dbPath + '-journal';
    const shmPath = this.dbPath + '-shm';

    return {
      walMode: fs.existsSync(walPath),
      journalMode: fs.existsSync(journalPath),
      shmExists: fs.existsSync(shmPath)
    };
  }

  /**
   * 创建单个文件/目录监听器
   */
  private createDatabaseWatcher(name: string, targetPath: string): fs.FSWatcher | null {
    try {
      if (!fs.existsSync(targetPath)) {
        console.log(`   ⚠️  Target not found: ${name} (${targetPath})`);
        return null;
      }

      const watcher = fs.watch(targetPath, { persistent: true }, (eventType, filename) => {
        this.handleDatabaseEvent(name, eventType, filename, targetPath);
      });

      watcher.on('error', (error: Error) => {
        console.error(`❌ [${name.toUpperCase()}] Watcher error:`, error.message);
        this.restartWatcher(name, targetPath);
      });

      this.dbWatchers.set(name, { watcher, path: targetPath });
      console.log(`   ✅ ${name}: ${path.basename(targetPath)}`);

      return watcher;
    } catch (error) {
      console.error(`❌ Failed to create watcher for ${name}:`, error);
      return null;
    }
  }

  /**
   * 处理数据库相关事件
   */
  private handleDatabaseEvent(watcherName: string, eventType: string, filename: string | null, targetPath: string): void {
    // 过滤相关的文件变化
    if (this.isRelevantDatabaseChange(watcherName, filename)) {
      const eventSource = `${watcherName}:${eventType}${filename ? ':' + filename : ''}`;

      // 只显示数据库主文件的变化，减少噪声
      // if (watcherName === 'main_db' || (filename && filename.includes('state.vscdb'))) {
      //   const timestamp = new Date().toISOString();
      //   console.log(`📁 [${timestamp}] ${eventSource}`);
      // }

      // 通过事件去重器触发检查
      this.eventDebouncer.trigger(eventSource);
    }
  }

  /**
   * 判断是否是相关的数据库变化
   */
  private isRelevantDatabaseChange(watcherName: string, filename: string | null): boolean {
    const dbFileName = path.basename(this.dbPath);

    switch (watcherName) {
      case 'main_db':
        return true;
      case 'db_dir':
        if (!filename) return false;
        return filename.includes(dbFileName) || this.isAtomicWriteFile(filename) || this.isSQLiteRelatedFile(filename);
      case 'wal':
      case 'journal':
      case 'shm':
        return true;
      default:
        return false;
    }
  }

  /**
   * 检测原子写入的临时文件
   */
  private isAtomicWriteFile(filename: string): boolean {
    const atomicPatterns = [
      /\.tmp$/,
      /\.temp$/,
      /\.\w{6,}$/,
      /state\.vscdb\.\w+$/
    ];
    return atomicPatterns.some(pattern => pattern.test(filename));
  }

  /**
   * 检测 SQLite 相关文件
   */
  private isSQLiteRelatedFile(filename: string): boolean {
    const sqlitePatterns = [
      /-wal$/,
      /-journal$/,
      /-shm$/,
      /\.db$/,
      /\.sqlite$/,
      /\.vscdb$/
    ];
    return sqlitePatterns.some(pattern => pattern.test(filename));
  }

  /**
   * 自动重启监听器
   */
  private restartWatcher(name: string, targetPath: string): void {
    console.log(`🔄 [${name.toUpperCase()}] Attempting to restart watcher...`);

    const oldWatcher = this.dbWatchers.get(name);
    if (oldWatcher && oldWatcher.watcher) {
      try {
        oldWatcher.watcher.close();
      } catch (error) {
        console.error(`⚠️  Error closing old watcher:`, error);
      }
    }

    this.dbWatchers.delete(name);

    setTimeout(() => {
      try {
        this.createDatabaseWatcher(name, targetPath);
        console.log(`✅ [${name.toUpperCase()}] Watcher restarted successfully`);
      } catch (error) {
        console.error(`❌ [${name.toUpperCase()}] Restart failed:`, error);
      }
    }, 2000);
  }

  /**
   * 监听数据库文件变化 - 智能 Debounce 多目标监控
   * @param callback 当数据库变化时调用的回调函数
   * @returns 返回停止监听的函数
   */
  watchForChanges(callback: () => void): () => void {
    if (!this.isAvailable()) {
      throw new Error(`Cannot watch database: ${this.dbPath} is not available`);
    }

    console.log('🚀 [DB_WATCH] Starting intelligent debounce database monitoring...');
    console.log(`📁 [DB_WATCH] Target: ${this.dbFileName}`);
    console.log('🧠 [DB_WATCH] Smart debounce + metadata check');

    this.currentCallback = callback;

    // 初始化文件元数据缓存
    const initialMeta = this.getDatabaseMetadata();
    this.fileMetaCache = {
      size: initialMeta.size,
      mtime: initialMeta.mtime,
      lastCheck: 0 // 允许首次检查
    };

    // 设置 debounce 回调
    this.eventDebouncer.setCallback(async (sources: string[]) => {
      await this.smartCheckForNewItems();
    });

    try {
      // 检测 SQLite 文件模式
      const dbMode = this.detectSQLiteMode();
      console.log(`   📊 SQLite mode: WAL=${dbMode.walMode}, Journal=${dbMode.journalMode}`);

      // 1. 监听主数据库文件
      this.createDatabaseWatcher('main_db', this.dbPath);

      // 2. 监听数据库目录（捕获原子写入）
      this.createDatabaseWatcher('db_dir', this.dbDir);

      // 3. 监听 WAL 文件（如果存在）
      if (dbMode.walMode) {
        const walPath = this.dbPath + '-wal';
        this.createDatabaseWatcher('wal', walPath);
      }

      // 4. 监听 Journal 文件（如果存在）
      if (dbMode.journalMode) {
        const journalPath = this.dbPath + '-journal';
        this.createDatabaseWatcher('journal', journalPath);
      }

      // 5. 监听 SHM 文件（Shared Memory，与 WAL 一起使用）
      if (dbMode.walMode) {
        const shmPath = this.dbPath + '-shm';
        if (fs.existsSync(shmPath)) {
          this.createDatabaseWatcher('shm', shmPath);
        }
      }

      const watcherCount = this.dbWatchers.size;
      // console.log(`   ✅ Created ${watcherCount} intelligent watchers`);
      // console.log('   🎯 Monitoring: main DB, directory, WAL/Journal files');

    } catch (error) {
      console.error(`❌ [DB_WATCH] Failed to start watching:`, error);
      throw new Error(`Failed to start database watching: ${error}`);
    }

    // 返回停止监听的函数
    return () => this.stopWatching();
  }

  /**
   * 停止数据库监听
   */
  private stopWatching(): void {
    console.log('🛑 [DB_WATCH] Stopping database monitoring...');

    // 停止所有数据库监听器
    let stoppedCount = 0;
    for (const [name, watcherInfo] of this.dbWatchers.entries()) {
      try {
        if (watcherInfo.watcher) {
          watcherInfo.watcher.close();
          stoppedCount++;
        }
      } catch (error) {
        console.error(`⚠️  Error stopping ${name} watcher:`, error);
      }
    }
    this.dbWatchers.clear();
    console.log(`   ✅ ${stoppedCount} database watchers stopped`);

    // 清理事件去重器
    this.eventDebouncer.clear();
    this.currentCallback = null;
    console.log('   ✅ Event debouncer cleared');
  }

  /**
   * 获取监听器状态信息
   */
  getWatcherStatus(): {
    isWatching: boolean;
    watcherCount: number;
    pendingEvents: number;
    dbFileName: string;
    fileMetaCache: { size: number; mtime: number; lastCheck: number };
  } {
    return {
      isWatching: this.dbWatchers.size > 0,
      watcherCount: this.dbWatchers.size,
      pendingEvents: 0, // eventDebouncer internal state
      dbFileName: this.dbFileName,
      fileMetaCache: { ...this.fileMetaCache }
    };
  }

  /**
   * 获取数据库文件状态信息
   */
  async getStatus(): Promise<{
    exists: boolean;
    accessible: boolean;
    size: number;
    lastModified: Date | null;
    error?: string;
  }> {
    const result = {
      exists: false,
      accessible: false,
      size: 0,
      lastModified: null as Date | null,
      error: undefined as string | undefined
    };

    try {
      result.exists = fs.existsSync(this.dbPath);

      if (result.exists) {
        const stats = fs.statSync(this.dbPath);
        result.size = stats.size;
        result.lastModified = stats.mtime;

        try {
          fs.accessSync(this.dbPath, fs.constants.R_OK);
          result.accessible = true;
        } catch (accessErr) {
          result.error = `Database file is not readable: ${accessErr}`;
        }
      } else {
        result.error = 'Database file does not exist';
      }
    } catch (statErr) {
      result.error = `Failed to get database file stats: ${statErr}`;
    }

    return result;
  }
}
