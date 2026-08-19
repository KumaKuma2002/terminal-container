# Terminal Container

Terminal sessions in a chat-history-style sidebar — real shells, cozy themes, liquid-glass UI.

## News

- **2026-08-19 — Liquid Glass redesign.** Floating frosted panes with refractive chromatic edges, pointer-tracked specular, and film grain; warmer, cozier styling throughout.
- **Font picker.** Seven distinct terminal fonts — SF Mono, Apple Braille, Noteworthy, Monaco, Cutive Mono (typewriter), Space Mono, Martian Mono — plus a size stepper. Choices persist across launches.
- **Terminal tabs & web previews.** Tab strip with drag-to-reorder, embedded web preview tabs for localhost dev servers, and grid mode to watch many sessions at once.
- **Cozy theme system.** Eight themes (Pure White, Silver, Claude Cozy, Mocha, Matcha, Pink, Dark, Grey Dark) plus Auto, saved per user.
- **Shortcuts.** ⌘T / ⌘N open a new terminal; ⌘L focuses the preview address bar.

## Quick Start

```bash
npm install   # postinstall restores node-pty's spawn-helper exec bit
npm start
```

- **⌘T / ⌘N** — new terminal (the **+** buttons work too)
- Theme & font pickers live in the sidebar footer
- **▦ Grid / ▭ Single** in the topbar tiles every session at once
