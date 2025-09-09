import { AICodeStats } from './types';
import { AICodeStorage } from './storage';
import { WorkspaceUtils } from '../utils/workspace-utils';

export class StatsAggregator {
  constructor(private storage: AICodeStorage) {}

  updateFromStorage(stats: AICodeStats): void {
    const totalStats = this.storage.getTotalStats();
    stats.aiGeneratedLines = totalStats.totalAILines;

    stats.files.clear();
    const all = this.storage.getAllFileStats();
    for (const [, fsStat] of all) {
      stats.files.set(fsStat.relativePath, {
        totalLines: 0,
        aiLines: fsStat.totalAILines,
        percentage: 0,
      });
    }
  }

  updateSourceBreakdown(stats: AICodeStats): void {
    let tab = 0; let composer = 0; let total = 0;
    const all = this.storage.getAllFileStats();
    for (const [, fsStat] of all) {
      for (const line of fsStat.codeLines) {
        if (line.source === 'tab') tab++;
        else if (line.source === 'composer') composer++;
        total++;
      }
    }
    stats.tabCompletionLines = tab;
    stats.composerLines = composer;
    stats.aiGeneratedLines = total; // keep in sync with breakdown
    if (stats.totalLines > 0) {
      stats.percentage = (stats.aiGeneratedLines / stats.totalLines) * 100;
    } else {
      stats.percentage = 0;
    }
  }

  async refreshTotals(stats: AICodeStats): Promise<void> {
    const { totalLines, fileStats } = await WorkspaceUtils.calculateTotalLines();
    stats.totalLines = totalLines;
    stats.files = fileStats;

    // recalc per-file percentage
    for (const [, f] of stats.files) {
      f.percentage = f.totalLines > 0 ? (f.aiLines / f.totalLines) * 100 : 0;
    }

    if (stats.totalLines > 0) {
      stats.percentage = (stats.aiGeneratedLines / stats.totalLines) * 100;
    } else {
      stats.percentage = 0;
    }
  }
}

