# Terminal Container

An Electron app that holds your terminal sessions in a **chat-history-style sidebar**.
Each row is a live shell; a status dot shows its state (🟢 running · ⚪ idle · 🔴 exited),
and clicking a row focuses that terminal in the main area.

Built on `xterm.js` + `node-pty`, with a warm "cozy" theme system (cream/clay light
themes, plus dark, grey, mocha, matcha, and rose).

## Run

```bash
npm install   # postinstall restores node-pty's spawn-helper exec bit
npm start
```

`node-pty` ships N-API prebuilt binaries that are ABI-compatible with Electron, so no
native rebuild is needed.

## Features

- **Sessions sidebar** — searchable list of live shells with per-session status dots.
- **Grid mode** — toggle **▦ Grid / ▭ Single** in the topbar to tile every session at
  once; the focused tile is outlined in the accent color. Useful for watching several
  terminals together.
- **Themes** — pick from the footer theme menu. Two light themes (Pure White, Silver)
  and dark/grey-based themes (Claude Cozy, Mocha, Matcha, Pink, Dark, Grey Dark), or
  **Auto** to follow the OS. The choice persists in `localStorage`.

## Layout

- **`main.js`** — Electron main process: spawns shells with `node-pty`, tracks activity
  state (running ⇄ idle ⇄ exited), parses OSC title sequences, exposes IPC.
- **`preload.js`** — `contextBridge` exposing a safe `window.termAPI`
  (`contextIsolation: true`, `nodeIntegration: false`).
- **`renderer/`** — the UI: `index.html`, `styles.css` (theme tokens + sidebar), and
  `renderer.js` (terminals, session list, theme picker).
- **`CONTRACT.md`** — the integration contract (IPC channels, `termAPI` shape, DOM
  ids/classes, style tokens). Start here to extend the app.

## Theming

Color tokens live in `renderer/styles.css` (one `:root[data-theme="…"]` block per theme);
the matching terminal palettes are the `xterm` objects in the `THEMES` array in
`renderer/renderer.js`. Add a theme by adding a block in each.

## License

MIT
