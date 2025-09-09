# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Lens is a VS Code extension that monitors and analyzes AI-generated code in your workspace. It integrates with Cursor's SQLite database to detect AI-generated content and provides statistics through an interactive dashboard.

## Development Commands

### Core Commands
- `npm run compile` - Compile TypeScript using build.mjs (esbuild with tsc fallback)
- `npm run watch` - Watch mode for development (auto-compile on changes)
- `npm run lint` - Run ESLint on TypeScript files in src/
- `npm run package` - Create VSIX package for distribution
- `npm run watcher` - Run standalone cursor-ai-watcher.js for debugging

### Build System
- `build.mjs` - Custom build script with esbuild bundling and safe fallback to tsc
- Bundles `src/extension.ts` to `out/extension.js` when esbuild is available
- Copies webview assets and icon automatically
- Keeps native dependencies external (sqlite3, vscode)

## Architecture

AI Lens follows a layered architecture with clear separation of concerns:

### Core Layer (`src/core/`)
- **ai-lens.ts** - Main orchestrator and lifecycle manager
- **storage.ts** - Persistent AI code statistics storage (~/.ailens/ai-stats.json)
- **stats-aggregator.ts** - Statistical calculations and aggregations
- **types.ts** - Unified type definitions

### Providers Layer (`src/providers/`)
- **cursor/cursor-database.ts** - SQLite database monitoring for Cursor's state.vscdb
- **registry.ts** - Provider registration system for extensibility
- **types.ts** - Provider interfaces

### Runtime Layer (`src/runtime/`)
- **document-monitor.ts** - VS Code document change monitoring
- **line-capture.ts** - Document change to line record transformation
- **document-version-history.ts** - Lightweight change history for deletion inference

### Hashing Layer (`src/hashing/`)
- **hash.ts** - MurmurHash3 implementation (Cursor-compatible)
- **line-inference.ts** - Hash-to-content inference engine

### Analysis Layer (`src/analysis/`)
- **timing-analyzer.ts** - Event correlation analysis
- **code-operation-analyzer.ts** - Operation-level analysis
- **git-commit-analyzer.ts** - Git commit dimension analysis
- **stats/file-stats.ts** - File-level statistics for UI

### UI Layer (`src/ui/`)
- **dashboard-webview.ts** - WebView dashboard container
- **helpers/git.ts** - Git information utilities

## Core Data Flow

1. **Runtime Collection**: DocumentMonitor captures editor changes → LineCapture generates line records → LineInference caches for hash matching
2. **Provider Input**: CursorDatabase monitors SQLite → pushes AI items to Core
3. **Content Matching**: LineInference matches file/operation/content hashes with AI items → triggers match callbacks to `core/ai-lens.updateAIStatsOnHashMatch` → Storage
4. **Statistics**: StatsAggregator aggregates stored data, calculates totals/percentages/breakdowns; Timing/Operation analyzers provide explanation data
5. **Visualization**: Dashboard WebView pulls details through FileStatsService, GitCommitAnalyzer provides commit-level data; supports export

## Key Technical Details

### AI Detection Methods
1. **SQLite Monitoring** - Primary method watching Cursor's database for new AI tracking entries
2. **Hash Matching** - MurmurHash3 correlation between database entries and actual code content  
3. **Document Change Analysis** - Secondary validation through VS Code text change events

### Database Integration
- Monitors Cursor's SQLite database at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Reads `ItemTable` with key `aiCodeTrackingLines`
- Read-only access to avoid Cursor interference
- Supports both tab completion and chat composer detection

### Hash Inference System
- **LineBasedHashInference** engine matches AI items to document changes
- Uses time-windowed caching (300s) for efficient matching
- Calculates hashes using format: `${fileName}:${operation}${content}`
- Handles both addition (+) and deletion (-) operations

### Testing Coordination
**Important**: This project requires coordination with other Cursor windows for testing. When testing AI item and document change monitoring, operate in separate Cursor windows to generate the events. If testing times out, skip rather than wait indefinitely.

## Extension Integration
- **Main entry**: `src/extension.ts` - AILensExtension class managing lifecycle
- **WebView**: `src/webview/dashboard.html` + `dashboard.js` - Interactive statistics dashboard
- **VS Code Commands**: 
  - `ailens.openDashboard` - Open statistics dashboard
  - `ailens.startMonitoring` - Start AI code monitoring
  - `ailens.stopMonitoring` - Stop monitoring
  - `ailens.showStats` - Show quick stats popup

## Configuration
- `ailens.autoStart` (default: true) - Auto-start monitoring on VS Code open
- `ailens.updateInterval` (default: 1000ms) - Monitoring update interval
- `ailens.showNotifications` (default: true) - Show AI detection notifications

## TypeScript Configuration
- Target: ES2020, CommonJS modules
- Strict mode with comprehensive type checking
- Output: `out/` directory with source maps and declarations
- Tests excluded from compilation: `.tests/` directory ignored