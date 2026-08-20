# Terminal Container

Terminal sessions in a chat-history-style sidebar — real shells, cozy themes, liquid-glass UI.

## News

- **2026-08-20 — Native host (Swift + WKWebView).** A Chromium-free shell with real under-window vibrancy: `native/build.sh` builds `build/TerminalContainer.app` using only Xcode Command Line Tools. The Electron version still works via `npm start`.
- **Liquid Glass, edge to edge.** The whole window is one glass material — no outer frame; login shells with full color env (TERM/COLORTERM/Homebrew PATH); flowing-wave app icon.
- **Font picker.** Seven distinct terminal fonts — SF Mono, Apple Braille, Noteworthy, Monaco, Cutive Mono (typewriter), Space Mono, Martian Mono — plus a size stepper. Choices persist across launches.
- **Terminal tabs & web previews.** Tab strip with drag-to-reorder, embedded web preview tabs for localhost dev servers, and grid mode to watch many sessions at once.
- **Cozy theme system.** Eight themes (Pure White, Silver, Claude Cozy, Mocha, Matcha, Pink, Dark, Grey Dark) plus Auto, saved per user.
- **Shortcuts.** ⌘T / ⌘N open a new terminal; ⌘L focuses the preview address bar.

## Quick Start

```bash
git clone https://github.com/KumaKuma2002/terminal-container.git
cd terminal-container
npm install            # postinstall restores node-pty's spawn-helper exec bit

# Option A — Electron
npm start

# Option B — native (lighter, real vibrancy; needs Xcode Command Line Tools)
native/build.sh && open build/TerminalContainer.app
```

- **⌘T / ⌘N** — new terminal (the **+** buttons work too)
- Theme & font pickers live in the sidebar footer
- **▦ Grid / ▭ Single** in the topbar tiles every session at once
