# Terminal Container

An Electron app that **contains terminal sessions in a chat-history-style sidebar panel**.
Each row is a live shell session; the row for an actively-running terminal is highlighted
with a colored activity badge (green = running, grey = idle, red = exited). Clicking a row
focuses that terminal in the main area. Light/dark themes included.

Style follows the minimal, light-mode aesthetic of `openresearch.sh/templates/qwen-maxrl`
(white background, near-black text, `#2563eb` blue accent, hairline borders, generous whitespace),
plus a full dark theme.

## Architecture

Same pattern as Hyper / Tabby / VS Code:

- **`main.js`** — Electron main process. Spawns real shells with `node-pty`, runs the
  activity state machine (running ⇄ idle on a 600ms debounce, exited on process end),
  parses OSC title sequences, and exposes everything over IPC.
- **`preload.js`** — `contextBridge` that exposes a safe `window.termAPI` to the renderer
  (secure mode: `contextIsolation: true`, `nodeIntegration: false`).
- **`renderer/`** — `index.html` + `styles.css` (the styled sidebar panel) and `renderer.js`
  (xterm.js terminals, session list, focus/switch, theme toggle).
- **`CONTRACT.md`** — the shared integration contract (IPC channels, `termAPI` shape,
  DOM ids/classes, style tokens). The source of truth if you extend the app.

## Run (dev)

```bash
cd ~/terminal-container
npm install        # postinstall fixes node-pty's spawn-helper exec bit
npm start
```

`node-pty` ships N-API prebuilt binaries that are ABI-compatible with Electron, so **no
native rebuild is required** — `build/postinstall.js` only restores the `spawn-helper`
execute bit that npm extraction can drop (otherwise pty spawn fails with `posix_spawnp failed`).

## Launch like a normal app

A double-clickable bundle lives at **`~/Desktop/Terminal Container.app`**. It points
straight at the bundled Electron binary, so it works from Finder without `node` on the PATH.
If you move the project out of `~/terminal-container`, update `APP_DIR` in
`Terminal Container.app/Contents/MacOS/terminal-container`.

## Dark mode

Toggle with the 🌙 / ☀️ button in the sidebar footer. The choice is persisted in
`localStorage`; with no explicit choice the app follows the macOS system appearance live.

## Window (grid) mode

Toggle **▦ Grid / ▭ Single** in the topbar. Grid mode tiles *every* session in one
window — each tile has a header (title + close), the focused tile is outlined in the
accent color, and clicking a tile focuses it for typing. Useful for watching/prompting
several terminals at once. The choice is persisted in `localStorage` (`tc-layout`).
All visible terminals are auto-fitted on layout change, window resize, and session
add/remove.

## Buttons & colors

Color set follows the reference (white bg / near-black text / `#2563eb` blue accent /
hairline borders). Buttons match the reference's signature CTA: a solid near-black
primary (`--btn-*` tokens, inverted to light-on-dark in dark mode) and quiet
`.btn-ghost` outline secondaries.

## Themes / icon

- Edit color tokens in `renderer/styles.css` (`:root` for light, `:root[data-theme="dark"]`
  for dark) and the xterm theme objects in `renderer/renderer.js`.
- The app icon (`build/icon.svg`) is an Anthropic-style minimalist mark: an ivory
  squircle, a warm near-black prompt chevron, and a single clay-orange cursor accent.
- Regenerate after editing the SVG:
  `cairosvg build/icon.svg -o build/icon-1024.png` → `sips` resize into an `.iconset`
  → `iconutil -c icns build/app.iconset -o build/app.icns`, then copy into the Desktop
  bundle's `Contents/Resources/app.icns` and **re-sign** (`codesign --force --sign - "<App>"`)
  since changing Resources invalidates the ad-hoc signature.
