# Changelog

- v1.1.5
  - Fix memory leaks in long-running sessions (cleanup timers/watchers, cap in-memory caches, periodic pruning, ensure sql.js database connections are closed).
  - Improve cross-platform compatibility by switching to sql.js for Cursor DB access (no native bindings; works consistently on macOS/Windows/Linux).

# AI Lens — AI Code Statistics & Analysis for VS Code

Track and analyze AI-generated code in your workspace. AI Lens monitors Cursor's SQLite database, matches AI items to actual code lines via hash inference, and provides detailed statistics showing exactly how much of your codebase was AI-generated.

## Features
- Real‑time monitoring of AI events (Cursor)
- Line‑level matching via hashing inference
- Workspace stats: total lines, AI lines, source breakdown
- Dashboard with per‑file details and export

## Screenshot
![AI Lens Dashboard](assets/screenshots/screenshot-1.png)

## Commands (Command Palette)
- AI Lens: Open AI Dashboard
- AI Lens: Start AI Code Monitoring
- AI Lens: Stop AI Code Monitoring
- AI Lens: Show AI Code Statistics

## Settings
- `ailens.autoStart` (default `true`)
- `ailens.showNotifications` (default `true`)
- `ailens.debug` (default `false`) — enable verbose logs for troubleshooting

For architecture and technical details, see [TECH_DESIGN.md](./TECH_DESIGN.md).
