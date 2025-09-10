#!/usr/bin/env node

/**
 * Cursor AI Watcher (Native Events Edition)
 * 纯 Node.js 原生事件驱动监控 - 零轮询架构
 * 
 * 功能:
 * - 使用 Node.js 原生 fs.watch API 监听多个 SQLite 相关文件
 * - 智能检测 WAL/Journal/SHM 模式，动态监听对应文件
 * - 事件去重与延迟合并，避免重复检查
 * - 原子写入检测，捕获临时文件变化
 * - 自动错误恢复和重连机制
 * 
 * 架构优势:
 * - 🚀 零轮询：完全事件驱动，CPU 使用率极低
 * - ⚡ 低延迟：利用 macOS FSEvents 的原生性能
 * - 🎯 高可靠：多层监听确保不遗漏任何变化
 * - 🔧 原生实现：只使用 Node.js 内置 API，无外部依赖
 * 
 * 使用方式:
 * - node cursor-ai-watcher.js          # 启动原生事件监听（推荐）
 * - node cursor-ai-watcher.js --status # 显示当前状态
 * - node cursor-ai-watcher.js --check  # 手动检查一次
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
// Removed sqlite3 dependency - using sql.js instead
// 移除 chokidar 依赖，使用 Node.js 原生 API

/**
 * 智能 Debounce 事件处理器
 * 使用 debounce 模式等待数据库写入完成，结合最大延迟保护
 */
class SmartEventDebouncer {
    constructor(delay = 300, maxDelay = 2000) {
        this.delay = delay;                    // debounce 延迟
        this.maxDelay = maxDelay;              // 最大延迟保护
        this.timer = null;
        this.pendingEvents = new Set();
        this.callback = null;
        this.firstTriggerTime = null;          // 第一次触发时间
    }

    setCallback(callback) {
        this.callback = callback;
    }

    trigger(eventSource) {
        this.pendingEvents.add(eventSource);
        
        const now = Date.now();
        
        // 记录第一次触发时间
        if (!this.firstTriggerTime) {
            this.firstTriggerTime = now;
            console.log(`🎬 [DEBOUNCE_START] First event received, starting debounce timer...`);
        }
        
        // 检查是否超过最大延迟
        const elapsedTime = now - this.firstTriggerTime;
        if (elapsedTime >= this.maxDelay) {
            console.log(`⏰ [MAX_DELAY] Reached maximum delay (${this.maxDelay}ms), executing immediately`);
            this.execute();
            return;
        }
        
        // 清除之前的定时器并重新开始倒计时（debounce 模式）
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.execute();
        }, this.delay);
        
        const remainingMaxDelay = this.maxDelay - elapsedTime;
        console.log(`⏳ [DEBOUNCE] Event added, waiting ${this.delay}ms (max remaining: ${remainingMaxDelay}ms)`);
    }

    execute() {
        if (this.callback && this.pendingEvents.size > 0) {
            const sources = Array.from(this.pendingEvents);
            const totalElapsed = this.firstTriggerTime ? Date.now() - this.firstTriggerTime : 0;
            
            this.pendingEvents.clear();
            this.firstTriggerTime = null;
            clearTimeout(this.timer);
            
            // 智能分组显示
            const groupedSources = this.groupEventSources(sources);
            
            console.log(`🔄 [DEBOUNCE_EXECUTE] Processing ${sources.length} events after ${totalElapsed}ms quiet period: ${this.formatEventGroups(groupedSources)}`);
            
            this.callback(sources);
        }
    }

    /**
     * 按事件类型分组
     */
    groupEventSources(sources) {
        const groups = {};

        sources.forEach(source => {
            const [watcher, eventType] = source.split(':');
            const key = `${watcher}:${eventType}`;

            if (!groups[key]) {
                groups[key] = 0;
            }
            groups[key]++;
        });

        return groups;
    }

    /**
     * 格式化事件组显示
     */
    formatEventGroups(groups) {
        const formatted = Object.entries(groups).map(([key, count]) => {
            return count > 1 ? `${key}(×${count})` : key;
        });

        return formatted.join(', ');
    }

    clear() {
        clearTimeout(this.timer);
        this.pendingEvents.clear();
        this.firstTriggerTime = null;
    }
}

class CursorAIWatcher {
    constructor() {
        this.dbPath = this.getCursorDatabasePath();
        this.historyPath = this.getCursorHistoryPath();
        this.lastKnownItems = []; // 上次已知的完整数组
        this.lastItemHash = null; // 上次数组中最后一个项的哈希
        this.unmatchedAIItems = []; // 未匹配的AI项队列
        this.pendingIntermediates = []; // 待处理的可能中间状态

        // 新的优化机制
        this.latestVersionCache = new Map(); // 每个目录的最新版本缓存: dirPath → latestFile
        this.timeWindows = new Map(); // 时间窗口内的版本列表: fileName → [recentVersions]
        this.foundMappings = new Map(); // 已找到的哈希映射: hash → {file, line, operation}

        // LRU 队列用于统一显示
        this.aiItemsLRU = []; // 最多10000个项的LRU队列
        this.matchedHashes = new Set(); // 已匹配成功的哈希集合
        this.matchedDetails = new Map(); // 已匹配哈希的详细信息: hash → matchResult
        this.newlyAddedHashes = new Set(); // 本次新增的哈希集合（用于背景色显示）

        this.isInitialized = false;

        // 原生事件监听器
        this.dbWatchers = new Map(); // 多个数据库相关文件的监听器
        this.historyWatcher = null;
        this.eventDebouncer = new SmartEventDebouncer(300, 2000); // 智能 debounce：300ms延迟，2s最大延迟
        
        // 文件元数据缓存
        this.fileMetaCache = {
            size: 0,
            mtime: 0,
            lastCheck: 0
        };

        console.log('🔍 Cursor AI Watcher (Native Events) Started');
        console.log(`🗄️  Database: ${this.dbPath}`);
        console.log(`📁 History: ${this.historyPath}`);
    }

    /**
     * 获取数据库文件元数据
     */
    getDatabaseMetadata() {
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
    async smartCheckForNewItems() {
        // 1. 元数据检查：文件是否真的有变化
        const currentMeta = this.getDatabaseMetadata();
        if (!currentMeta.exists) {
            console.log(`❌ [META_CHECK] Database file not found`);
            return;
        }

        const hasMetadataChanged = 
            currentMeta.size !== this.fileMetaCache.size || 
            currentMeta.mtime !== this.fileMetaCache.mtime;

        if (!hasMetadataChanged) {
            console.log(`📊 [META_CHECK] File metadata unchanged, skipping database query`);
            console.log(`   Size: ${currentMeta.size}, Modified: ${new Date(currentMeta.mtime).toISOString()}`);
            return;
        }

        // 2. 记录元数据变化
        console.log(`📊 [META_CHECK] File metadata changed, proceeding with database check:`);
        console.log(`   Size: ${this.fileMetaCache.size} → ${currentMeta.size}`);
        console.log(`   Modified: ${new Date(this.fileMetaCache.mtime).toISOString()} → ${new Date(currentMeta.mtime).toISOString()}`);
        
        // 3. 更新缓存
        this.fileMetaCache = {
            size: currentMeta.size,
            mtime: currentMeta.mtime,
            lastCheck: Date.now()
        };

        // 4. 执行实际的数据库内容检查
        console.log(`🔍 [SMART_CHECK] Performing database content check...`);
        await this.checkForNewItems();
    }

    /**
     * 获取Cursor数据库路径
     */
    getCursorDatabasePath() {
        const platform = os.platform();
        let basePath;

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
     * 获取Cursor History路径
     */
    getCursorHistoryPath() {
        const platform = os.platform();
        let basePath;

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

        return path.join(basePath, 'User/History');
    }

    /**
     * MurmurHash3 32位哈希算法实现
     * 与Cursor内部使用的算法完全一致
     */
    murmurhash3(str, seed = 0) {
        let h1 = seed;
        const c1 = 0xcc9e2d51;
        const c2 = 0x1b873593;

        const len = str.length;
        const nblocks = len >>> 2; // len / 4

        // 32位乘法运算，处理溢出
        const multiply32 = (a, b) => {
            return ((a & 0xffff) * b + (((a >>> 16) * b & 0xffff) << 16)) & 0xffffffff;
        };

        // 32位左旋转
        const rotateLeft32 = (x, n) => {
            return (x << n) | (x >>> (32 - n));
        };

        // 处理完整的4字节块
        for (let i = 0; i < nblocks; i++) {
            const i4 = i * 4;
            let k1 = (str.charCodeAt(i4) & 0xff) |
                ((str.charCodeAt(i4 + 1) & 0xff) << 8) |
                ((str.charCodeAt(i4 + 2) & 0xff) << 16) |
                ((str.charCodeAt(i4 + 3) & 0xff) << 24);

            k1 = multiply32(k1, c1);
            k1 = rotateLeft32(k1, 15);
            k1 = multiply32(k1, c2);

            h1 ^= k1;
            h1 = rotateLeft32(h1, 13);
            h1 = multiply32(h1, 5);
            h1 = (h1 + 0xe6546b64) & 0xffffffff;
        }

        // 处理剩余字节
        const tail = len & 3;
        if (tail > 0) {
            let k1 = 0;
            const tailStart = nblocks * 4;

            if (tail >= 3) { k1 ^= (str.charCodeAt(tailStart + 2) & 0xff) << 16; }
            if (tail >= 2) { k1 ^= (str.charCodeAt(tailStart + 1) & 0xff) << 8; }
            if (tail >= 1) { k1 ^= (str.charCodeAt(tailStart) & 0xff); }

            k1 = multiply32(k1, c1);
            k1 = rotateLeft32(k1, 15);
            k1 = multiply32(k1, c2);
            h1 ^= k1;
        }

        // 最终化
        h1 ^= len;
        h1 ^= h1 >>> 16;
        h1 = multiply32(h1, 0x85ebca6b);
        h1 ^= h1 >>> 13;
        h1 = multiply32(h1, 0xc2b2ae35);
        h1 ^= h1 >>> 16;

        return (h1 >>> 0).toString(16);
    }


    /**
     * 检查单个entries.json文件是否匹配AI项
     */
    async checkEntriesForMatch(entriesPath, aiItem) {
        try {
            const entriesContent = fs.readFileSync(entriesPath, 'utf8');
            const entriesData = JSON.parse(entriesContent);
            // 检查文件名是否匹配
            if (!this.matchFileName(aiItem.metadata.fileName, entriesData.resource)) {
                return { found: false };
            }

            // 获取目录中的所有文件，按修改时间倒序排列（最新的先遍历）
            const dirPath = path.dirname(entriesPath);

            const allFiles = fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(dirent => dirent.isFile() && dirent.name !== 'entries.json')
                .map(dirent => {
                    const filePath = path.join(dirPath, dirent.name);
                    const stats = fs.statSync(filePath);
                    return {
                        path: filePath,
                        mtime: stats.mtime
                    };
                })
                .sort((a, b) => b.mtime - a.mtime) // 按修改时间倒序
                .map(item => item.path); // 只返回路径


            // 依次遍历所有副本文件（按时间倒序），找到匹配就立即返回
            for (const filePath of allFiles) {

                const match = await this.analyzeFileForHash(filePath, aiItem);
                if (match.found) {
                    return match;
                }
            }

            return { found: false };
        } catch (error) {
            return { found: false };
        }
    }

    /**
     * 匹配文件名
     */
    matchFileName(aiItemFileName, entriesResource) {
        try {
            const resourcePath = new URL(entriesResource).pathname;
            return resourcePath.endsWith(aiItemFileName);
        } catch {
            return false;
        }
    }

    /**
     * 核心哈希匹配函数 - 分析代码行并查找哈希匹配
     */
    findHashMatchInLines(codeLines, aiItem) {
        const fileName = aiItem.metadata.fileName;
        const operations = ['+', '-'];

        for (let i = 0; i < codeLines.length; i++) {
            const line = codeLines[i];
            for (const op of operations) {
                const hashInput = `${fileName}:${op}${line}`;
                const calculatedHash = this.murmurhash3(hashInput, 0);

                if (calculatedHash === aiItem.hash) {
                    return {
                        found: true,
                        lineNumber: i + 1,
                        content: line,
                        operation: op,
                        hashInput: hashInput
                    };
                }
            }
        }

        return { found: false };
    }

    /**
     * 分析文件副本并查找哈希匹配
     */
    async analyzeFileForHash(copyPath, aiItem) {
        try {
            const copyContent = fs.readFileSync(copyPath, 'utf8');
            const codeLines = copyContent.split('\n');

            const match = this.findHashMatchInLines(codeLines, aiItem);
            if (match.found) {
                // 添加文件路径信息
                return {
                    ...match,
                    filePath: copyPath
                };
            }

            return { found: false };
        } catch (error) {
            console.error('Error in analyzeFileForHash:', error.message);
            console.error('File path:', copyPath);

            return { found: false };
        }
    }

    /**
     * 初始化 - 加载现有的AI追踪项数组和历史版本
     */
    async initialize() {
        console.log('\n📊 Initializing - loading existing AI tracking items...');

        try {
            // 初始化文件元数据缓存
            const initialMeta = this.getDatabaseMetadata();
            this.fileMetaCache = {
                size: initialMeta.size,
                mtime: initialMeta.mtime,
                lastCheck: 0 // 允许首次检查
            };
            console.log(`   📊 Initial database metadata: size=${initialMeta.size}, mtime=${new Date(initialMeta.mtime).toISOString()}`);

            const items = await this.loadAITrackingItems();
            if (items && Array.isArray(items)) {
                this.lastKnownItems = [...items];
                if (items.length > 0) {
                    this.lastItemHash = items[items.length - 1].hash;
                }
                console.log(`   ✅ Loaded ${items.length} existing items, last hash: ${this.lastItemHash || 'none'}`);
            } else {
                this.lastKnownItems = [];
                this.lastItemHash = null;
                console.log('   📝 No existing items found');
            }

            // 初始化最新版本缓存
            await this.initializeLatestVersions();

            // 初始化LRU队列
            this.updateLRUQueue(items || []);

            // 初始化完成后，清空新增标记（启动时的项不算新增）
            this.newlyAddedHashes.clear();

            this.isInitialized = true;
        } catch (error) {
            console.error('❌ Failed to initialize:', error.message);
            throw error;
        }
    }

    /**
     * 初始化最新版本缓存 - 扫描所有目录的最新文件
     */
    async initializeLatestVersions() {
        console.log('\n🚀 Initializing: scanning all directories for latest versions...');

        try {
            const historyDirs = this.getAllHistoryDirectories();
            let initializedCount = 0;

            for (const dirPath of historyDirs) {
                const latestFile = this.getLatestFileInDirectory(dirPath);
                if (latestFile) {
                    this.latestVersionCache.set(dirPath, latestFile);

                    // 初始化该文件的时间窗口（只包含最新版本）
                    const filePath = this.getFilePathFromEntries(dirPath);
                    if (filePath) {
                        this.timeWindows.set(filePath, [latestFile]);
                        initializedCount++;
                    } else {
                        // 没有 entries.json 的目录，使用目录名作为 key
                        this.timeWindows.set(`orphan:${path.basename(dirPath)}`, [latestFile]);
                        initializedCount++;
                    }
                }
            }

            console.log(`   ✅ Initialized ${initializedCount} file windows from ${historyDirs.length} directories`);
        } catch (error) {
            console.error('   ⚠️  Error during initialization:', error.message);
        }
    }

    /**
     * 获取所有历史目录
     */
    getAllHistoryDirectories() {
        if (!fs.existsSync(this.historyPath)) {
            return [];
        }

        return fs.readdirSync(this.historyPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => path.join(this.historyPath, dirent.name));
    }

    /**
     * 获取目录中的最新文件
     */
    getLatestFileInDirectory(dirPath) {
        try {
            const files = fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(dirent => dirent.isFile() && dirent.name !== 'entries.json')
                .map(dirent => {
                    const filePath = path.join(dirPath, dirent.name);
                    const stats = fs.statSync(filePath);
                    return {
                        name: dirent.name,
                        path: filePath,
                        mtime: stats.mtime
                    };
                })
                .sort((a, b) => b.mtime - a.mtime); // 最新的在前

            return files[0] || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 从 entries.json 获取文件路径
     */
    getFilePathFromEntries(dirPath) {
        try {
            const entriesPath = path.join(dirPath, 'entries.json');
            if (!fs.existsSync(entriesPath)) {
                return null;
            }

            const entriesContent = fs.readFileSync(entriesPath, 'utf8');
            const entriesData = JSON.parse(entriesContent);

            if (entriesData.resource) {
                return new URL(entriesData.resource).pathname; // 返回完整路径
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 更新时间窗口 - 当检测到新文件时调用，并触发精准批量处理
     */
    async updateTimeWindow(filePath) {
        try {
            const dirPath = path.dirname(filePath);
            const resourcePath = this.getFilePathFromEntries(dirPath);

            const windowKey = resourcePath || `orphan:${path.basename(dirPath)}`;

            const fileInfo = {
                name: path.basename(filePath),
                path: filePath,
                mtime: fs.statSync(filePath).mtime
            };

            // 获取当前时间窗口
            const currentWindow = this.timeWindows.get(windowKey) || [];

            // 添加新文件并按时间排序
            currentWindow.push(fileInfo);
            currentWindow.sort((a, b) => b.mtime - a.mtime); // 最新的在前

            // 保持窗口大小（最近5个版本）
            if (currentWindow.length > 5) {
                currentWindow.splice(5);
            }

            this.timeWindows.set(windowKey, currentWindow);

            // 更新最新版本缓存
            this.latestVersionCache.set(dirPath, fileInfo);

            // 触发新文件的精准批量处理
            await this.handleNewFile(filePath);

        } catch (error) {
            console.error('   ⚠️  Error updating time window:', error.message);
        }
    }

    /**
     * 从数据库加载AI追踪项（使用 sql.js WASM，跨架构）
     */
    async loadAITrackingItems() {
        if (!fs.existsSync(this.dbPath)) {
            throw new Error(`Cursor database not found: ${this.dbPath}`);
        }

        try {
            // 动态导入 sql.js
            const initSqlJs = (await import('sql.js')).default;

            // wasm 路径：从 node_modules 中查找
            const SQL = await initSqlJs();
            
            const fileBuffer = fs.readFileSync(this.dbPath);
            const db = new SQL.Database(fileBuffer);
            try {
                const query = "SELECT value FROM ItemTable WHERE key='aiCodeTrackingLines'";
                const res = db.exec(query);

                if (!res || res.length === 0 || !res[0].values || res[0].values.length === 0) {
                    return null;
                }

                const value = res[0].values[0][0];
                try {
                    const data = JSON.parse(value);
                    return data;
                } catch (parseErr) {
                    console.error('   ❌ Error parsing aiCodeTrackingLines:', parseErr.message);
                    throw parseErr;
                }
            } finally {
                try { db.close(); } catch {}
            }
        } catch (err) {
            throw new Error(`Failed to read Cursor DB with sql.js: ${err?.message || err}`);
        }
    }

    /**
     * 检查并报告新增的AI追踪项
     * 基于LRU数组的特性，通过比较最后一个已知哈希的位置来检测新增项
     */
    async checkForNewItems() {
        try {
            console.log(`🔍 [CHECK] === Checking for new items at ${new Date().toISOString()} ===`);

            const currentItems = await this.loadAITrackingItems();
            if (!currentItems || !Array.isArray(currentItems)) {
                console.log(`❌ [CHECK] No items found or invalid data`);
                return;
            }

            console.log(`📊 [CHECK] Current items: ${currentItems.length}, Known items: ${this.lastKnownItems.length}`);

            const currentLastHash = currentItems.length > 0 ? currentItems[currentItems.length - 1].hash : null;
            console.log(`📊 [CHECK] Current last hash: ${currentLastHash}, Last known hash: ${this.lastItemHash}`);

            let newItems = [];

            if (this.lastItemHash === null) {
                console.log(`🆕 [CHECK] First run - treating all items as baseline`);
                // 首次检查，所有项都是新的
                newItems = [...currentItems];
            } else if (currentLastHash !== this.lastItemHash) {
                console.log(`🔄 [CHECK] Last hash changed! Analyzing differences...`);

                // 找到上次最后一个哈希在当前数组中的位置
                const lastKnownIndex = currentItems.findIndex(item => item.hash === this.lastItemHash);

                if (lastKnownIndex === -1) {
                    console.log(`⚠️ [CHECK] Last known hash not found - doing full comparison`);
                    // 上次的最后一个哈希不在当前数组中，说明数组变化很大
                    // 这种情况下我们需要比较整个数组来找出新增项
                    const lastKnownHashSet = new Set(this.lastKnownItems.map(item => item.hash));
                    newItems = currentItems.filter(item => !lastKnownHashSet.has(item.hash));
                } else {
                    console.log(`✅ [CHECK] Found last known hash at index ${lastKnownIndex}`);
                    console.log(`📊 [CHECK] New items count: ${currentItems.length - lastKnownIndex - 1}`);
                    // 从上次已知位置之后的所有项都是新增的
                    newItems = currentItems.slice(lastKnownIndex + 1);
                }
            } else {
                console.log(`✨ [CHECK] No changes detected`);
            }

            // 更新已知状态（静默更新，减少日志）
            this.lastKnownItems = [...currentItems];
            if (currentItems.length > 0) {
                this.lastItemHash = currentItems[currentItems.length - 1].hash;
                // 只在有新项目时显示哈希更新
                if (newItems.length > 0) {
                    console.log(`📌 [CHECK] Updated last known hash: ${this.lastItemHash.substring(0, 8)}...`);
                }
            }

            // 更新LRU队列
            this.updateLRUQueue(currentItems);

            if (newItems.length > 0) {
                console.log(`\n🎯 [CHANGE DETECTED] ${newItems.length} NEW AI items!`);

                // 显示新项目的简要信息
                newItems.forEach((item, index) => {
                    console.log(`   ${index + 1}. Hash: ${item.hash}, File: ${item.metadata?.fileName || 'unknown'}, Source: ${item.metadata?.source || 'unknown'}`);
                });

                // 清空之前的新增标记
                this.newlyAddedHashes.clear();
                // 标记新增的哈希
                newItems.forEach(item => this.newlyAddedHashes.add(item.hash));

                console.log(`📊 Processing ${newItems.length} new AI items...`);
                await this.handleNewAIItems(newItems);
                // 显示LRU队列状态
                this.displayLRUStatus();

                console.log(`🎉 [SUCCESS] Successfully processed AI code changes!\n`);
            } else {
                console.log(`✨ [CHECK] No new items detected\n`);
            }

        } catch (error) {
            console.error('❌ Error checking for new items:', error.message);
        }
    }

    /**
     * 启动原生数据库监控 - 多目标事件驱动
     */
    startDatabaseWatching() {
        console.log('\n🔄 Starting native database monitoring...');

        // 设置事件处理回调
        this.eventDebouncer.setCallback(async (sources) => {
            console.log(`📝 [DB_EVENT] Database change detected from: ${sources.join(', ')}`);
            await this.smartCheckForNewItems();
        });

        // 检测 SQLite 文件模式
        const dbMode = this.detectSQLiteMode();
        console.log(`   📊 SQLite mode: WAL=${dbMode.walMode}, Journal=${dbMode.journalMode}`);

        // 1. 监听主数据库文件
        this.createDatabaseWatcher('main_db', this.dbPath);

        // 2. 监听数据库目录（捕获原子写入）
        const dbDir = path.dirname(this.dbPath);
        this.createDatabaseWatcher('db_dir', dbDir);

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
        console.log(`   ✅ Created ${watcherCount} native watchers (zero polling)`);
        console.log('   🎯 Monitoring: main DB, directory, WAL/Journal files');
    }

    /**
     * 检测 SQLite 工作模式
     */
    detectSQLiteMode() {
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
    createDatabaseWatcher(name, targetPath) {
        try {
            if (!fs.existsSync(targetPath)) {
                console.log(`   ⚠️  Target not found: ${name} (${targetPath})`);
                return null;
            }

            const watcher = fs.watch(targetPath, { persistent: true }, (eventType, filename) => {
                this.handleDatabaseEvent(name, eventType, filename, targetPath);
            });

            // 错误处理
            watcher.on('error', (error) => {
                console.error(`❌ [${name.toUpperCase()}] Watcher error:`, error.message);
                this.restartWatcher(name, targetPath);
            });

            this.dbWatchers.set(name, { watcher, path: targetPath });
            console.log(`   ✅ ${name}: ${path.basename(targetPath)}`);

            return watcher;
        } catch (error) {
            console.error(`❌ Failed to create watcher for ${name}:`, error.message);
            return null;
        }
    }

    /**
     * 处理数据库相关事件
     */
    handleDatabaseEvent(watcherName, eventType, filename, targetPath) {
        // 过滤相关的文件变化
        if (this.isRelevantDatabaseChange(watcherName, filename, targetPath)) {
            const eventSource = `${watcherName}:${eventType}${filename ? ':' + filename : ''}`;

            // 只显示数据库主文件的变化，减少噪声
            if (watcherName === 'main_db' || (filename && filename.includes('state.vscdb'))) {
                const timestamp = new Date().toISOString();
                console.log(`📁 [${timestamp}] ${eventSource}`);
            }

            // 通过事件去重器触发检查
            this.eventDebouncer.trigger(eventSource);
        }
    }

    /**
     * 判断是否是相关的数据库变化
     */
    isRelevantDatabaseChange(watcherName, filename, targetPath) {
        const dbFileName = path.basename(this.dbPath);

        switch (watcherName) {
            case 'main_db':
                // 主文件变化都相关
                return true;

            case 'db_dir':
                // 目录变化：只关心与数据库相关的文件
                if (!filename) { return false; }

                // 先检查是否是应该忽略的文件
                if (this.isIgnorableFile(filename)) {
                    return false;
                }

                return filename.includes(dbFileName) ||
                    this.isAtomicWriteFile(filename) ||
                    this.isSQLiteRelatedFile(filename);

            case 'wal':
            case 'journal':
            case 'shm':
                // WAL/Journal/SHM 文件的所有变化都相关
                return true;

            default:
                return false;
        }
    }

    /**
     * 检测原子写入的临时文件
     */
    isAtomicWriteFile(filename) {
        const atomicPatterns = [
            /\.tmp$/,
            /\.temp$/,
            /\.\w{6,}$/,  // 随机后缀
            /state\.vscdb\.\w+$/  // SQLite 临时文件
        ];

        return atomicPatterns.some(pattern => pattern.test(filename));
    }

    /**
     * 检测应该被忽略的无关文件
     */
    isIgnorableFile(filename) {
        const ignorablePatterns = [
            /storage\.json/,           // VS Code storage 文件
            /storage\.json\.vsctmp/,   // VS Code storage 临时文件
            /\.vsctmp$/,              // VS Code 临时文件后缀
            /\.log$/,                 // 日志文件
            /\.lock$/,                // 锁文件
            /\~$/,                    // 备份文件
            /\.bak$/,                 // 备份文件
        ];

        return ignorablePatterns.some(pattern => pattern.test(filename));
    }

    /**
     * 检测 SQLite 相关文件
     */
    isSQLiteRelatedFile(filename) {
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
    restartWatcher(name, targetPath) {
        console.log(`🔄 [${name.toUpperCase()}] Attempting to restart watcher...`);

        // 清理旧的监听器
        const oldWatcher = this.dbWatchers.get(name);
        if (oldWatcher && oldWatcher.watcher) {
            try {
                oldWatcher.watcher.close();
            } catch (error) {
                console.error(`⚠️  Error closing old watcher:`, error.message);
            }
        }

        this.dbWatchers.delete(name);

        // 延迟重启，避免快速重启循环
        setTimeout(() => {
            try {
                this.createDatabaseWatcher(name, targetPath);
                console.log(`✅ [${name.toUpperCase()}] Watcher restarted successfully`);
            } catch (error) {
                console.error(`❌ [${name.toUpperCase()}] Restart failed:`, error.message);
            }
        }, 2000);
    }


    /**
     * 启动原生History文件夹监控
     */
    startHistoryWatching() {
        console.log('\n🔄 Starting native History folder monitoring...');

        if (!fs.existsSync(this.historyPath)) {
            console.log(`   ⚠️  History folder does not exist: ${this.historyPath}`);
            return;
        }

        try {
            this.historyWatcher = fs.watch(this.historyPath, {
                persistent: true,
                recursive: true  // 递归监听所有子目录
            }, async (eventType, filename) => {
                if (filename) {
                    const filePath = path.join(this.historyPath, filename);
                    await this.handleHistoryEvent(eventType, filePath, filename);
                }
            });

            this.historyWatcher.on('error', (error) => {
                console.error('❌ History watcher error:', error);
                this.restartHistoryWatcher();
            });

            console.log('   ✅ History folder monitoring active (native)');
            console.log(`   📂 Watching: ${this.historyPath}`);
        } catch (error) {
            console.error('❌ Failed to start History monitoring:', error.message);
        }
    }

    /**
     * 处理 History 目录事件
     */
    async handleHistoryEvent(eventType, filePath, filename) {
        const timestamp = new Date().toISOString();
        const relativePath = path.relative(this.historyPath, filePath);

        // 检查文件是否仍然存在（区分添加/修改 vs 删除）
        const exists = fs.existsSync(filePath);

        if (exists && eventType === 'rename') {
            // 文件新增
            console.log(`\n[${timestamp}] 📄 NEW FILE: ${relativePath}`);

            try {
                // 更新时间窗口并触发精准批量处理
                await this.updateTimeWindow(filePath);

                // 如果仍有未匹配的AI项，尝试重新匹配（作为兜底机制）
                if (this.unmatchedAIItems.length > 0 || this.pendingIntermediates.length > 0) {
                    await this.retryUnmatchedItems();
                }
            } catch (error) {
                console.error(`   ❌ Error processing new file: ${error.message}`);
            }

        } else if (exists && eventType === 'change') {
            // 文件修改
            console.log(`\n[${timestamp}] ✏️  MODIFIED: ${relativePath}`);

        } else if (!exists && eventType === 'rename') {
            // 文件删除
            console.log(`\n[${timestamp}] 🗑️  DELETED: ${relativePath}`);
        }
    }

    /**
     * 重启 History 监听器
     */
    restartHistoryWatcher() {
        console.log('🔄 Attempting to restart History watcher...');

        if (this.historyWatcher) {
            try {
                this.historyWatcher.close();
            } catch (error) {
                console.error('⚠️  Error closing old History watcher:', error.message);
            }
            this.historyWatcher = null;
        }

        setTimeout(() => {
            this.startHistoryWatching();
        }, 2000);
    }

    /**
     * 启动监控
     */
    async startWatching() {
        try {
            // 首先初始化
            await this.initialize();

            // 启动两个监控器
            this.startDatabaseWatching();
            this.startHistoryWatching();

            console.log('\n🎯 Monitoring started successfully!');
            console.log('   📊 Database changes will trigger AI tracking checks');
            console.log('   📁 History folder changes will be logged');
            console.log('\n⏳ Waiting for changes... (Press Ctrl+C to stop)');

        } catch (error) {
            console.error('❌ Failed to start monitoring:', error.message);
            process.exit(1);
        }
    }

    /**
     * 停止监控
     */
    stopWatching() {
        console.log('\n👋 Stopping watchers...');

        // 停止所有数据库监听器
        let stoppedCount = 0;
        for (const [name, watcherInfo] of this.dbWatchers.entries()) {
            try {
                if (watcherInfo.watcher) {
                    watcherInfo.watcher.close();
                    stoppedCount++;
                }
            } catch (error) {
                console.error(`⚠️  Error stopping ${name} watcher:`, error.message);
            }
        }
        this.dbWatchers.clear();
        console.log(`   ✅ ${stoppedCount} database watchers stopped`);

        // 停止 History 监听器
        if (this.historyWatcher) {
            try {
                this.historyWatcher.close();
                console.log('   ✅ History watcher stopped');
            } catch (error) {
                console.error('⚠️  Error stopping History watcher:', error.message);
            }
            this.historyWatcher = null;
        }
        console.error('   ✅ History watcher stopped');
        // 清理事件去重器
        this.eventDebouncer.clear();

        console.log('   🎯 All native monitoring stopped');
    }

    /**
     * 处理新的AI项列表 - 包括中间状态检测（简化版本）
     */
    async handleNewAIItems(newAIItems) {
        console.log(`\n📊 Processing ${newAIItems.length} new AI items...`);

        for (let i = 0; i < newAIItems.length; i++) {
            const currentItem = newAIItems[i];

            // 先尝试在时间窗口中搜索
            const match = await this.searchInTimeWindow(currentItem);

            if (match.found) {
                this.markAsMatched(currentItem.hash, match);
            } else if (i < newAIItems.length - 1) {
                // 如果没找到且不是最后一个项，检查是否为中间状态
                const nextItem = newAIItems[i + 1];
                const intermediateResult = await this.detectIntermediate(currentItem, nextItem);

                if (intermediateResult.found) {
                    this.markAsMatched(currentItem.hash, intermediateResult);
                } else {
                    // 静默添加到未匹配队列，无详细日志
                    const isDuplicate = this.unmatchedAIItems.some(existing => existing.hash === currentItem.hash);
                    if (!isDuplicate) {
                        this.unmatchedAIItems.push(currentItem);
                    }
                }
            } else {
                // 最后一个项没找到，加入待处理队列
                const isDuplicate = this.unmatchedAIItems.some(existing => existing.hash === currentItem.hash);
                if (!isDuplicate) {
                    this.unmatchedAIItems.push(currentItem);
                }
            }
        }
    }

    /**
     * 在时间窗口内搜索AI项
     */
    async searchInTimeWindow(aiItem) {
        const aiItemFileName = aiItem.metadata.fileName;

        // 找到匹配的时间窗口
        const matchingWindow = this.findMatchingTimeWindow(aiItemFileName);

        if (!matchingWindow) {
            return await this.searchInOrphanDirectories(aiItem);
        }

        const { timeWindow } = matchingWindow;

        // 按时间顺序搜索（最新的先搜索）
        for (const version of timeWindow) {
            const match = await this.analyzeFileForHash(version.path, aiItem);
            if (match.found) {
                // 缓存结果
                this.foundMappings.set(aiItem.hash, {
                    ...match,
                    fileName: aiItemFileName,
                    version: version.path,
                    timestamp: version.mtime
                });

                return match;
            }
        }
        console.error('No paired symbols found', aiItemFileName);
        return { found: false, reason: 'not_in_window' };
    }

    /**
     * 找到匹配的时间窗口（基于右子串匹配）
     */
    findMatchingTimeWindow(aiItemFileName) {
        for (const [windowKey, timeWindow] of this.timeWindows.entries()) {
            if (windowKey.startsWith('orphan:')) {
                continue; // 先跳过孤儿目录
            }

            // 检查 windowKey 是否以 aiItemFileName 结尾
            if (windowKey.endsWith(aiItemFileName)) {
                return { windowKey, timeWindow };
            }
        }

        return null;
    }

    /**
     * 在孤儿目录中搜索（没有 entries.json 的目录）
     */
    async searchInOrphanDirectories(aiItem) {
        for (const [windowKey, timeWindow] of this.timeWindows.entries()) {
            if (!windowKey.startsWith('orphan:')) {
                continue;
            }

            for (const version of timeWindow) {
                const match = await this.analyzeFileForHash(version.path, aiItem);
                if (match.found) {
                    // 缓存结果
                    this.foundMappings.set(aiItem.hash, {
                        ...match,
                        fileName: aiItem.metadata.fileName,
                        version: version.path,
                        timestamp: version.mtime
                    });

                    return match;
                }
            }
        }

        return { found: false, reason: 'not_found_anywhere' };
    }

    /**
     * 检测中间状态
     */
    async detectIntermediate(suspectedItem, nextItem) {
        // 检查是否符合中间状态模式
        if (!this.isLikelyIntermediatePair(suspectedItem, nextItem)) {
            return { found: false };
        }

        // 找到下一个项的完整内容
        const nextMatch = await this.searchInTimeWindow(nextItem);
        if (!nextMatch.found) {
            return { found: false };
        }

        // 基于下一个项的内容推断当前项
        return this.generateIntermediateFromNext(suspectedItem, nextMatch);
    }

    /**
     * 判断是否是可能的中间状态对
     */
    isLikelyIntermediatePair(item1, item2) {
        return (
            // 同一个文件
            item1.metadata.fileName === item2.metadata.fileName &&
            // 都是tab补全
            item1.metadata.source === 'tab' &&
            item2.metadata.source === 'tab'
            // 时间相近（在LRU数组中相邻）
        );
    }

    /**
     * 基于下一项生成中间状态
     */
    generateIntermediateFromNext(suspectedItem, nextMatch) {
        const fileName = suspectedItem.metadata.fileName;
        const fullContent = nextMatch.content;
        // 找到第一个非空白字符的位置
        const firstNonSpace = fullContent.search(/\S/);
        // 如果全是空白或空字符串，从0开始；否则从非空白字符的前一位开始
        const startPos = firstNonSpace === -1 ? 0 : firstNonSpace;
        // 最多遍历10个字符
        const maxPrefixes = Math.min(100, fullContent.trim().length);

        for (let i = 0; i <= maxPrefixes; i++) {
            const prefix = fullContent.substring(0, startPos + i);
            const testInput = `${fileName}:-${prefix}`;
            const testHash = this.murmurhash3(testInput, 0);
            if (testHash === suspectedItem.hash) {
                return {
                    found: true,
                    type: 'intermediate_state',
                    content: prefix,
                    operation: '-',
                    hashInput: testInput,
                    derivedFrom: {
                        nextItemHash: nextMatch.hash || 'unknown',
                        fullContent: fullContent
                    }
                };
            }
        }

        // 如果简单前缀匹配失败，尝试成对符号推断
        return this.generateIntermediateFromPairedSymbols(suspectedItem, nextMatch);
    }

    /**
  * 基于成对符号自动补齐原理推断中间状态
  * 修复：处理所有可能的成对符号位置，而不仅仅是第一个
  */
    generateIntermediateFromPairedSymbols(suspectedItem, nextMatch) {
        const fileName = suspectedItem.metadata.fileName;
        const fullContent = nextMatch.content;

        const pairedSymbols = {
            '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`'
        };

        // 收集所有可能的成对符号位置
        const allSymbolPairs = [];

        for (let i = 0; i < fullContent.length; i++) {
            const currentChar = fullContent[i];
            if (pairedSymbols[currentChar]) {
                const closeSymbol = pairedSymbols[currentChar];
                const closePos = this.findMatchingCloseSymbol(fullContent, i, currentChar, closeSymbol);

                if (closePos !== -1) {
                    allSymbolPairs.push({
                        openIndex: i,
                        closeIndex: closePos,
                        openSymbol: currentChar,
                        closeSymbol: closeSymbol,
                        content: fullContent.substring(i + 1, closePos)
                    });
                }
            }
        }

        // 对每个符号对尝试推导中间状态
        for (const pair of allSymbolPairs) {
            const { openIndex, closeIndex, openSymbol, closeSymbol, content } = pair;

            // 尝试所有可能的中间状态
            for (let inputLength = 0; inputLength <= content.length; inputLength++) {
                const userInput = content.substring(0, inputLength);

                // 重建中间状态：保持前后内容不变，只修改当前符号对内的内容
                const beforePair = fullContent.substring(0, openIndex + 1);
                const afterPair = fullContent.substring(closeIndex);

                const intermediateContent = beforePair + userInput + afterPair;

                const testInput = `${fileName}:-${intermediateContent}`;
                const testHash = this.murmurhash3(testInput, 0);

                console.log('x', testHash, suspectedItem.hash);
                if (testHash === suspectedItem.hash) {
                    return {
                        found: true,
                        type: 'paired_symbol_intermediate',
                        content: intermediateContent,
                        operation: '-',
                        hashInput: testInput,
                        derivedFrom: {
                            nextItemHash: nextMatch.hash,
                            fullContent: fullContent,
                            openSymbol: openSymbol,
                            closeSymbol: closeSymbol,
                            userInput: userInput,
                            openIndex: openIndex,
                            closeIndex: closeIndex,
                            cursorPosition: openIndex + 1 + inputLength
                        }
                    };
                }
            }
        }

        return { found: false };
    }

    /**
     * 改进的匹配闭合符号查找（处理嵌套情况）
     */
    findMatchingCloseSymbol(content, startIndex, openSymbol, closeSymbol) {
        let stack = 0;
        console.log("I'm Deepseek v3.1", content, startIndex, openSymbol, closeSymbol);
        for (let i = startIndex + 1; i < content.length; i++) {
            const char = content[i];

            if (char === openSymbol) {
                stack++;
            } else if (char === closeSymbol) {
                if (stack === 0) {
                    return i; // 找到匹配的闭合符号
                }
                stack--;
            }
        }

        return -1; // 未找到匹配的闭合符号
    }

    /**
     * 查找所有有效的成对符号区间
     * 使用栈处理嵌套结构，正确处理相同开闭符号
     */
    findSymbolPairs(content) {
        const pairedSymbols = {
            '(': ')',
            '[': ']',
            '{': '}',
            '"': '"',
            "'": "'",
            '`': '`'
        };

        const pairs = [];
        const stack = [];

        for (let i = 0; i < content.length; i++) {
            const char = content[i];

            // 检查是否是开始符号
            if (pairedSymbols[char]) {
                const closeChar = pairedSymbols[char];
                if (char === closeChar) {
                    // 相同开闭符号（如引号）的特殊处理
                    const nextPos = content.indexOf(char, i + 1);
                    if (nextPos !== -1) {
                        pairs.push({
                            openChar: char,
                            closeChar: char,
                            start: i,
                            end: nextPos,
                            innerContent: content.substring(i + 1, nextPos)
                        });
                        i = nextPos; // 跳过已处理的闭合符号
                    }
                } else {
                    // 不同开闭符号，使用栈处理
                    stack.push({ char, pos: i });
                }
            } else {
                // 检查是否是闭合符号
                const openChar = Object.keys(pairedSymbols).find(k => pairedSymbols[k] === char);
                if (openChar && stack.length > 0) {
                    const top = stack[stack.length - 1];
                    if (top.char === openChar) {
                        stack.pop();
                        pairs.push({
                            openChar: openChar,
                            closeChar: char,
                            start: top.pos,
                            end: i,
                            innerContent: content.substring(top.pos + 1, i)
                        });
                    }
                }
            }
        }

        return pairs;
    }

    /**
     * 为特定符号对尝试生成所有可能的中间状态
     */
    tryGenerateIntermediatesForPair(fileName, fullContent, pair, targetHash) {
        const { start, end, innerContent, openChar, closeChar } = pair;

        // 尝试不同长度的用户输入
        for (let j = 0; j <= innerContent.length; j++) {
            const userInput = innerContent.substring(0, j);

            // 重建中间状态：前缀 + 开始符号 + 用户输入 + 闭合符号 + 后缀
            const beforePair = fullContent.substring(0, start);
            const afterPair = fullContent.substring(end + 1);
            const intermediateContent = beforePair + openChar + userInput + closeChar + afterPair;

            const hashInput = `${fileName}:-${intermediateContent}`;
            const calculatedHash = this.murmurhash3(hashInput, 0);

            if (calculatedHash === targetHash) {
                return {
                    found: true,
                    content: intermediateContent,
                    hashInput: hashInput,
                    userInput: userInput
                };
            }
        }

        return { found: false };
    }

    /**
     * 前缀增量输入推导
     * 处理用户逐字符输入的场景，如 'P' → 'Pair', char, closeChar
     */
    tryPrefixIncrementalDeduction(fileName, fullContent, targetHash) {
        // 从完整内容开始，逐字符回退，尝试找到匹配的前缀状态
        for (let cutPoint = fullContent.length - 1; cutPoint >= 0; cutPoint--) {
            const truncatedContent = fullContent.substring(0, cutPoint);

            // 尝试多种可能的补全状态
            const candidates = this.generateCompletionCandidates(fullContent, truncatedContent, cutPoint);

            for (const candidate of candidates) {
                const hashInput = `${fileName}:-${candidate}`;
                const calculatedHash = this.murmurhash3(hashInput, 0);

                if (calculatedHash === targetHash) {
                    return {
                        found: true,
                        content: candidate,
                        hashInput: hashInput,
                        truncatedAt: cutPoint,
                        originalPart: truncatedContent,
                        completedPart: candidate.substring(truncatedContent.length)
                    };
                }
            }
        }

        return { found: false };
    }

    /**
     * 为给定的截断点生成可能的自动补全候选
     */
    generateCompletionCandidates(fullContent, truncatedContent, cutPoint) {
        const candidates = [];

        // 候选1: 直接截断（用户刚输入到这里）
        candidates.push(truncatedContent);

        // 候选2: 检查是否在引号、括号等内部，尝试自动补全闭合符号
        const autoCompletedVersions = this.tryAutoComplete(fullContent, truncatedContent, cutPoint);
        candidates.push(...autoCompletedVersions);

        // 候选3: 如果截断在单词中间，尝试补全到单词边界
        const wordCompletedVersions = this.tryWordBoundaryComplete(fullContent, truncatedContent, cutPoint);
        candidates.push(...wordCompletedVersions);

        // 去重并返回
        return [...new Set(candidates)].filter(c => c && c.length > 0);
    }

    /**
     * 尝试自动补全闭合符号
     */
    tryAutoComplete(fullContent, truncatedContent, cutPoint) {
        const candidates = [];

        // 检查最后一个字符是否是需要自动补全的符号
        const lastChar = truncatedContent[truncatedContent.length - 1];
        const autoCompleteMap = {
            '(': ')',
            '[': ']',
            '{': '}',
            '"': '"',
            "'": "'",
            '`': '`'
        };

        if (autoCompleteMap[lastChar]) {
            const closeChar = autoCompleteMap[lastChar];
            candidates.push(truncatedContent + closeChar);
        }

        // 特殊处理console.log引号内容的部分截断
        const quoteMatch = truncatedContent.match(/.*console\.log\('([^']*)$/);
        if (quoteMatch) {
            const partialContent = quoteMatch[1];
            // 为部分内容添加引号闭合
            const beforeQuote = truncatedContent.substring(0, truncatedContent.lastIndexOf("'" + partialContent));
            candidates.push(beforeQuote + "'" + partialContent + "')");
        }

        // 通用的引号内容处理：检查是否在引号内被截断
        const inQuoteMatch = truncatedContent.match(/(.*['"`])([^'"`]*)$/);
        if (inQuoteMatch) {
            const beforeQuote = inQuoteMatch[1];
            const partialContent = inQuoteMatch[2];
            const quoteChar = beforeQuote[beforeQuote.length - 1];
            candidates.push(beforeQuote + partialContent + quoteChar + ')');
        }

        return candidates;
    }

    /**
     * 尝试补全到单词边界
     */
    tryWordBoundaryComplete(fullContent, truncatedContent, cutPoint) {
        const candidates = [];

        // 如果截断在单词中间，尝试各种长度的补全
        const remainingContent = fullContent.substring(cutPoint);

        // 尝试补全1-5个字符（常见的部分单词补全）
        for (let addLen = 1; addLen <= Math.min(5, remainingContent.length); addLen++) {
            const extraChars = remainingContent.substring(0, addLen);
            candidates.push(truncatedContent + extraChars);
        }

        return candidates;
    }


    /**
     * 报告找到的匹配
     */
    reportMatch(match) {
        const isIntermediate = match.type === 'intermediate_state';
        const isPairedSymbol = match.type === 'paired_symbol_intermediate';
        const title = isIntermediate || isPairedSymbol ? 'INTERMEDIATE STATE FOUND' : 'MATCH FOUND';

        console.log(`      ✅ ${title}:`);

        // 公共信息
        if (match.content) { console.log(`         Content: "${match.content}"`); }
        if (match.operation) { console.log(`         Operation: ${match.operation}`); }
        if (match.hashInput) { console.log(`         Hash input: ${match.hashInput}`); }
        console.log('Hash', match.hashInput, match.hashInput.split(':')[1]);
        // 特定类型的信息
        if (isIntermediate && match.derivedFrom) {
            console.log(`         Derived from: ${match.derivedFrom.fullContent}`);
        } else if (isPairedSymbol && match.derivedFrom) {
            console.log(`         Paired symbols: ${match.derivedFrom.openSymbol}${match.derivedFrom.closeSymbol}`);
            console.log(`         User input: "${match.derivedFrom.userInput}"`);
            console.log(`         Derived from: ${match.derivedFrom.fullContent}`);
        } else {
            if (match.lineNumber) { console.log(`         Line: ${match.lineNumber}`); }
            if (match.filePath) { console.log(`         History: ${match.filePath}`); }
        }
    }


    /**
     * 重试匹配未找到的AI项（优化版本，作为兜底机制）
     */
    async retryUnmatchedItems() {
        const totalPending = this.unmatchedAIItems.length + this.pendingIntermediates.length;
        if (totalPending === 0) {
            return;
        }

        console.log(`\n🔄 Fallback retry for ${totalPending} pending items...`);

        // 重试普通未匹配项（使用传统时间窗口搜索）
        await this.retryRegularUnmatched();

        // 重试中间状态
        await this.retryPendingIntermediates();

        // 显示重试后的状态
        if (this.unmatchedAIItems.length + this.pendingIntermediates.length < totalPending) {
            this.displayLRUStatus();
        }
    }

    /**
     * 重试普通未匹配项
     */
    async retryRegularUnmatched() {
        if (this.unmatchedAIItems.length === 0) {
            return;
        }


        const stillUnmatched = [];
        let matchCount = 0;

        for (const unmatchedItem of this.unmatchedAIItems) {
            const match = await this.searchInTimeWindow(unmatchedItem);

            if (match.found) {
                this.markAsMatched(unmatchedItem.hash, match);
                matchCount++;
            } else {
                stillUnmatched.push(unmatchedItem);
            }
        }

        this.unmatchedAIItems = stillUnmatched;
    }

    /**
     * 重试中间状态
     */
    async retryPendingIntermediates() {
        if (this.pendingIntermediates.length === 0) {
            return;
        }


        const stillPending = [];
        let matchCount = 0;

        for (const pendingItem of this.pendingIntermediates) {
            let found = false;

            // 尝试与所有已找到的同文件的 + 操作匹配
            const sameFileMatches = this.getSameFileMatches(pendingItem.metadata.fileName);

            for (const match of sameFileMatches) {
                if (match.operation === '+') {
                    const intermediateResult = this.generateIntermediateFromNext(pendingItem, match);
                    if (intermediateResult.found) {
                        this.markAsMatched(pendingItem.hash, intermediateResult);
                        matchCount++;
                        found = true;
                        break;
                    }
                }
            }


            if (!found) {
                stillPending.push(pendingItem);
            }
        }

        this.pendingIntermediates = stillPending;
    }

    /**
     * 获取同文件的已找到匹配
     */
    getSameFileMatches(aiItemFileName) {
        return Array.from(this.foundMappings.values())
            .filter(match => {
                // 支持右子串匹配
                return match.fileName === aiItemFileName ||
                    match.fileName.endsWith(aiItemFileName) ||
                    aiItemFileName.endsWith(match.fileName);
            });
    }


    /**
     * 更新LRU队列，维护最多10000个项目
     */
    updateLRUQueue(currentItems) {
        // 将新项目添加到LRU队列尾部（最新的在后面）
        this.aiItemsLRU = [...currentItems];

        // 确保队列不超过10000项
        if (this.aiItemsLRU.length > 10000) {
            this.aiItemsLRU = this.aiItemsLRU.slice(-10000);
        }
    }

    /**
     * 显示LRU队列状态，使用颜色区分匹配和未匹配的哈希，并显示匹配项的详细信息
     */
    displayLRUStatus() {
        const matchedCount = this.matchedHashes.size;
        const totalCount = this.aiItemsLRU.length;
        const unmatchedCount = totalCount - matchedCount;

        console.log('\n📊 LRU Queue Status:');
        console.log(`   Total: ${totalCount} | Matched: \x1b[32m${matchedCount}\x1b[0m | Unmatched: \x1b[90m${unmatchedCount}\x1b[0m`);

        // 显示最近的20个哈希（如果少于20个则显示全部）
        const displayCount = Math.min(20, this.aiItemsLRU.length);
        const recentItems = this.aiItemsLRU.slice(-displayCount);

        console.log('\n   Recent hashes (newest first):');

        // 倒序显示（最新的在上面）
        for (let i = recentItems.length - 1; i >= 0; i--) {
            const item = recentItems[i];
            const hash = item.hash;
            const isMatched = this.matchedHashes.has(hash);
            const isNewlyAdded = this.newlyAddedHashes.has(hash);
            const color = isMatched ? '\x1b[32m' : '\x1b[90m'; // 绿色=匹配，灰色=未匹配
            const bgColor = isNewlyAdded ? '\x1b[43m' : ''; // 黄色背景=新增项
            const status = isMatched ? '✓' : '○';

            if (isMatched && this.matchedDetails.has(hash)) {
                const matchResult = this.matchedDetails.get(hash);
                const hashInput = matchResult.hashInput || 'unknown';
                console.log(`   ${bgColor}${color}${status} ${hash}\x1b[0m → "${hashInput}"`);
            } else {
                console.log(`   ${bgColor}${color}${status} ${hash}\x1b[0m`);
            }
        }

        if (this.aiItemsLRU.length > displayCount) {
            console.log(`   ... and ${this.aiItemsLRU.length - displayCount} more items`);
        }
    }

    /**
     * 标记哈希为已匹配，并触发即时推断
     */
    markAsMatched(hash, matchResult = null) {
        // 检查是否是新匹配（避免重复报告）
        const isNewMatch = !this.matchedHashes.has(hash);

        this.matchedHashes.add(hash);

        // 存储匹配详细信息用于调试显示
        if (matchResult) {
            this.matchedDetails.set(hash, matchResult);

            // 如果是新匹配，调用报告函数（包括中间状态）
            if (isNewMatch) {
                this.reportMatch(matchResult);
            }
        }

        // 如果提供了匹配结果且是+操作，立即推断前一个
        if (matchResult && matchResult.operation === '+') {
            this.immediatelyInferPreceding(hash, matchResult);
        }
    }

    /**
     * 即时推断前一个项是否为中间状态
     */
    immediatelyInferPreceding(currentHash, matchResult) {
        console.log('immediatelyInferPreceding', currentHash, matchResult);

        const currentIndex = this.findHashIndexInLRU(currentHash);
        if (currentIndex > 0) {
            const precedingItem = this.aiItemsLRU[currentIndex - 1];
            const currentItem = this.aiItemsLRU[currentIndex];

            // 检查前一个是否为unmatched且同文件
            if (!this.matchedHashes.has(precedingItem.hash) &&
                precedingItem.metadata.fileName === currentItem.metadata.fileName) {
                console.log('precedingItem', precedingItem);
                const result = this.generateIntermediateFromNext(precedingItem, matchResult);

                if (result.found) {
                    console.log(`      ⚡ IMMEDIATE INFERENCE: ${precedingItem.hash} → "${result.content}"`);
                    // 为推断出的中间状态创建匹配结果，用于显示
                    const inferredMatchResult = {
                        found: true,
                        operation: result.operation,
                        content: result.content,
                        hashInput: result.hashInput,
                        type: 'intermediate_state'
                    };
                    this.markAsMatched(precedingItem.hash, inferredMatchResult);
                    this.removeFromUnmatchedQueue(precedingItem.hash);
                }
            }
        }
    }

    /**
     * 在LRU队列中查找哈希的索引位置
     */
    findHashIndexInLRU(targetHash) {
        return this.aiItemsLRU.findIndex(item => item.hash === targetHash);
    }

    /**
     * 从未匹配队列中移除指定哈希
     */
    removeFromUnmatchedQueue(hash) {
        this.unmatchedAIItems = this.unmatchedAIItems.filter(item => item.hash !== hash);
    }

    /**
     * 处理新文件到达，精准批量处理相关的unmatched items
     */
    async handleNewFile(filePath) {
        // 1. 确定windowKey（利用现有逻辑）
        const windowKey = this.getWindowKeyFromFilePath(filePath);
        if (!windowKey) { return; }

        // 2. 找出该文件相关的unmatched items
        const relatedItems = this.unmatchedAIItems.filter(item =>
            this.isFileMatch(item.metadata.fileName, windowKey)
        );

        // 3. 如果有相关项，批量处理（只扫描一次）
        if (relatedItems.length > 0) {
            console.log(`      📁 Processing ${relatedItems.length} unmatched items for: ${windowKey}`);
            await this.batchAnalyzeFile(filePath, relatedItems);
        }
    }

    /**
     * 从文件路径获取对应的windowKey
     */
    getWindowKeyFromFilePath(filePath) {
        const dirPath = path.dirname(filePath);

        // 检查是否有对应的entries.json来获取resource路径
        const resourcePath = this.getFilePathFromEntries(dirPath);
        if (resourcePath) {
            return resourcePath;
        }

        // 否则使用orphan格式
        return `orphan:${path.basename(dirPath)}`;
    }

    /**
     * 检查AI项的fileName是否匹配windowKey
     */
    isFileMatch(aiItemFileName, windowKey) {
        if (windowKey.startsWith('orphan:')) {
            // 对于orphan目录，尝试基于文件名模糊匹配
            // 如果AI项的文件名包含在目录名中，可能是相关的
            const orphanDirName = windowKey.substring(7); // 去掉 "orphan:" 前缀
            return aiItemFileName.includes(orphanDirName) || orphanDirName.includes(path.basename(aiItemFileName, path.extname(aiItemFileName)));
        }

        // 检查windowKey是否以aiItemFileName结尾
        return windowKey.endsWith(aiItemFileName);
    }

    /**
     * 批量分析文件内容，匹配多个AI项
     */
    async batchAnalyzeFile(filePath, relatedItems) {
        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const codeLines = fileContent.split('\n');
            let matchCount = 0;

            for (const item of relatedItems) {
                const match = await this.analyzeContentForItem(codeLines, item);
                if (match.found) {
                    // 调用增强版的markAsMatched，触发推断
                    this.markAsMatched(item.hash, match);
                    this.removeFromUnmatchedQueue(item.hash);
                    matchCount++;
                }
            }

            if (matchCount > 0) {
                console.log(`      ✅ Batch matched ${matchCount}/${relatedItems.length} items in: ${path.basename(filePath)}`);
                this.displayLRUStatus();
            }

        } catch (error) {
            console.error(`      ❌ Error batch analyzing ${filePath}:`, error.message);
        }
    }

    /**
     * 分析文件内容是否匹配特定AI项
     */
    async analyzeContentForItem(codeLines, aiItem) {
        return this.findHashMatchInLines(codeLines, aiItem);
    }

    /**
     * 显示当前状态
     */
    showStatus() {
        console.log('\n📊 Current Status:');
        console.log(`   🗄️  Database: ${fs.existsSync(this.dbPath) ? '✅ Exists' : '❌ Not found'}`);
        console.log(`   📁 History: ${fs.existsSync(this.historyPath) ? '✅ Exists' : '❌ Not found'}`);
        console.log(`   🤖 Known items: ${this.lastKnownItems.length}`);
        console.log(`   🔚 Last item hash: ${this.lastItemHash || 'none'}`);
        console.log(`   ❌ Unmatched items: ${this.unmatchedAIItems.length}`);
        console.log(`   ⏳ Pending intermediates: ${this.pendingIntermediates.length}`);
        console.log(`   📁 Time windows: ${this.timeWindows.size} files`);
        console.log(`   💾 Found mappings cache: ${this.foundMappings.size} items`);

        // 显示数据库监听器状态
        console.log(`   🔄 Database watchers: ${this.dbWatchers.size} active`);
        for (const [name, info] of this.dbWatchers.entries()) {
            console.log(`      - ${name}: ${path.basename(info.path)}`);
        }

        console.log(`   📂 History watcher: ${this.historyWatcher ? '✅ Active' : '❌ Inactive'}`);
        console.log(`   ⚡ Event debouncer: ${this.eventDebouncer.pendingEvents.size} pending`);
        console.log(`   🎯 Mode: Native Events + Smart Debounce + Metadata Check`);

        // 显示文件元数据缓存状态
        console.log(`   📊 File metadata cache: size=${this.fileMetaCache.size}, mtime=${new Date(this.fileMetaCache.mtime).toISOString()}`);
        console.log(`   ⏱️  Last check: ${this.fileMetaCache.lastCheck ? new Date(this.fileMetaCache.lastCheck).toISOString() : 'Never'}`);
        console.log(`   🕐 Debounce config: ${this.eventDebouncer.delay}ms delay, ${this.eventDebouncer.maxDelay}ms max`);

        // 显示 SQLite 模式
        const dbMode = this.detectSQLiteMode();
        console.log(`   🗄️  SQLite mode: WAL=${dbMode.walMode}, Journal=${dbMode.journalMode}`);

        // 显示LRU状态
        this.displayLRUStatus();
    }
}

// 主函数
async function main() {
    const watcher = new CursorAIWatcher();

    const args = process.argv.slice(2);
    const command = args[0];

    try {
        switch (command) {
            case '--status':
            case '-s':
                await watcher.initialize();
                watcher.showStatus();
                break;

            case '--check':
            case '-c':
                await watcher.initialize();
                await watcher.checkForNewItems();
                break;

            case '--watch':
            case '-w':
            default:
                await watcher.startWatching();

                // 处理优雅退出
                process.on('SIGINT', () => {
                    console.log('\n\n🛑 Received interrupt signal...');
                    watcher.stopWatching();
                    process.exit(0);
                });

                process.on('SIGTERM', () => {
                    console.log('\n\n🛑 Received terminate signal...');
                    watcher.stopWatching();
                    process.exit(0);
                });

                // 保持进程运行
                setInterval(() => {
                    // 每30秒显示一次心跳
                    // console.log(`[${new Date().toISOString()}] 💓 Monitoring active...`);
                }, 30000);
                break;
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main();
}

module.exports = CursorAIWatcher;
