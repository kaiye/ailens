/**
 * Type definitions for AI Lens extension
 */

export interface AICodeItem {
  hash: string;
  metadata: {
    fileName: string;
    source: 'tab' | 'composer';
    timestamp: number;
  };
}

export interface MatchResult {
  found: boolean;
  lineNumber?: number;
  content?: string;
  operation?: '+' | '-';
  hashInput?: string;
  filePath?: string;
  type?: 'intermediate_state' | 'paired_symbol_intermediate';
  derivedFrom?: {
    nextItemHash?: string;
    fullContent?: string;
    openSymbol?: string;
    closeSymbol?: string;
    userInput?: string;
    openIndex?: number;
    closeIndex?: number;
    cursorPosition?: number;
  };
}

export interface AICodeStats {
  totalLines: number;
  aiGeneratedLines: number;
  tabCompletionLines: number;
  composerLines: number;
  percentage: number;
  files: Map<string, {
    totalLines: number;
    aiLines: number;
    percentage: number;
  }>;
}

// Storage-level AI code records
export interface AICodeLine {
  hash: string;
  operation: '+' | '-';
  content: string;
  timestamp: number;
  source: 'tab' | 'composer' | 'unknown';
  line?: number;
}

export interface AIFileStats {
  absolutePath: string;
  relativePath: string;
  totalAILines: number;
  addedLines: number;
  deletedLines: number;
  lastUpdate: number;
  codeLines: AICodeLine[];
}

export interface FileVersion {
  name: string;
  path: string;
  mtime: Date;
}

export interface TimeWindow {
  [key: string]: FileVersion[];
}

export interface AILensConfig {
  autoStart: boolean;
  showNotifications: boolean;
}

// Git Commit Analysis Types
export interface GitCommitAnalysis {
  currentBranch: string;
  recentCommits: CommitInfo[];
  lastAnalyzedAt: number;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  timestamp: number;
  message: string;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  aiAdditions: number;
  aiDeletions: number;
  aiContributionPercentage: number;
  files: FileChange[];
}

export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  aiAdditions: number;
  aiDeletions: number;
  addedLines: DiffLine[];
  deletedLines: DiffLine[];
}

export interface DiffLine {
  content: string;
  lineNumber?: number;
  isAIGenerated: boolean;
  aiItemHash?: string;
}

export interface AIMatchResult {
  matched: boolean;
  aiItem?: any;
  confidence: number;
}

export interface CommitAnalysisCache {
  [commitHash: string]: CachedCommitAnalysis;
}

export interface CachedCommitAnalysis {
  hash: string;
  analyzedAt: number;
  aiStorageVersion: string;
  analysis: CommitInfo;
  isStale: boolean;
}

export interface DocumentChange {
  document: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  rangeLength: number;
  text: string;
  timestamp: number;
  // 新增字段用于详细分析
  beforeText?: string;  // 变更前的原始内容
  afterText?: string;   // 变更后的内容
  operation: 'insert' | 'delete' | 'replace';
  affectedLines: number;
  changeId: string;     // 唯一标识符
}

export interface AICodeOperation {
  type: 'delete' | 'modify' | 'insert';
  linesCount: number;
  content: string;
  originalContent?: string;
  file: string;
  timestamp: number;
}

export interface AICodeAnalysisResult {
  totalDeletedLines: number;
  totalModifiedLines: number;
  totalInsertedLines: number;
  operations: AICodeOperation[];
  matchedChangeId?: string;
}
