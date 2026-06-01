# Terminal Container — Integration Contract

This is the SHARED CONTRACT. Three agents build against it in parallel. Do NOT change
the channel names, the `window.termAPI` shape, the DOM ids/classes, or the visual tokens
below — they are the integration boundary between the backend, the markup, and the logic.

App goal: an Electron app that contains terminal sessions in a left sidebar panel (like a
chat-history list). Each row is a session; the row for an "actively-using" terminal is
highlighted with a live activity badge. Clicking a row focuses that terminal in the main area.

Stack: Electron (secure mode — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`),
`node-pty` (real shells, in MAIN process), `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links`
(rendering, in RENDERER), bridged via a `preload.js` `contextBridge`.

---

## 1. Session object (used everywhere)

```js
Session = {
  id: string,          // uuid-ish, generated in main
  title: string,       // display name, e.g. "zsh — myproject"
  cwd: string,         // absolute working directory
  shell: string,       // shell path, e.g. "/bin/zsh"
  state: "running" | "idle" | "exited",
  createdAt: number    // Date.now()
}
```

`state` semantics (owned by MAIN, see activity state machine):
- `running` — pty produced output within the last 600ms (actively working/typing/output)
- `idle`    — alive but quiet for >600ms
- `exited`  — process ended

---

## 2. IPC channels (between preload and main)

Invoke (renderer→main, returns Promise):
- `"term:create"`  payload `{ cwd?, shell?, cols?, rows? }` → returns `Session`
- `"term:list"`    payload none → returns `Session[]`
- `"term:kill"`    payload `{ id }` → returns `{ ok: true }`

Send (renderer→main, fire-and-forget):
- `"term:input"`   payload `{ id, data }`        // keystrokes into the pty
- `"term:resize"`  payload `{ id, cols, rows }`
- `"term:focus"`   payload `{ id }`              // hint: which session is focused

Events (main→renderer, via `webContents.send`):
- `"term:data"`    payload `{ id, data }`        // pty output chunk
- `"term:exit"`    payload `{ id, exitCode }`
- `"term:state"`   payload `{ id, state }`       // state machine transitions
- `"term:title"`   payload `{ id, title }`       // title updates (e.g. from OSC 0/2 or cwd change)

---

## 3. `window.termAPI` (exposed by preload via contextBridge)

```js
window.termAPI = {
  create(opts)            // -> Promise<Session>
  list()                  // -> Promise<Session[]>
  kill(id)                // -> Promise<{ok:true}>
  input(id, data)         // -> void
  resize(id, cols, rows)  // -> void
  focus(id)               // -> void
  // each on* returns an unsubscribe function:
  onData(cb)              // cb({id, data})
  onExit(cb)              // cb({id, exitCode})
  onState(cb)             // cb({id, state})
  onTitle(cb)             // cb({id, title})
}
```

---

## 4. DOM contract (index.html structure — renderer.js depends on these ids/classes)

```html
<div id="app">
  <aside id="sidebar">
    <header class="sidebar-header">
      <div class="brand">Terminals</div>
      <button id="new-session-btn" title="New terminal">+</button>
    </header>
    <div class="sidebar-search">
      <input id="session-filter" type="text" placeholder="Search sessions" />
    </div>
    <ul id="session-list"><!-- renderer injects .session-item rows here --></ul>
    <footer class="sidebar-footer"><span id="session-count">0 sessions</span></footer>
  </aside>

  <main id="main">
    <div class="topbar">
      <span id="active-title">No terminal</span>
      <div class="topbar-actions">
        <button id="kill-active" title="Close terminal">Close</button>
      </div>
    </div>
    <div id="terminals"><!-- renderer mounts one .term-instance per session here --></div>
    <div id="empty-state">No terminals yet. Press + to start one.</div>
  </main>
</div>
```

Session row markup (renderer.js BUILDS this; index.html/styles.css must STYLE these classes).
Include ONE static example row inside #session-list in index.html so styling is visible, but
mark it with class `is-template` (renderer clears #session-list on first render):

```html
<li class="session-item" data-id="ID">
  <span class="session-status" data-state="running"></span>
  <span class="session-icon">›_</span>
  <div class="session-meta">
    <div class="session-title">zsh — myproject</div>
    <div class="session-subtitle">~/code/myproject</div>
  </div>
  <button class="session-close" title="Close">×</button>
</li>
```
- The selected/focused row also gets class `is-active`.
- `.session-status[data-state="running"|"idle"|"exited"]` drives the badge color (see tokens).
- Each `.term-instance` is `<div class="term-instance" data-id="ID"></div>`; the visible one
  also gets class `is-active` (others hidden via CSS `.term-instance:not(.is-active){display:none}`).

---

## 5. Visual style tokens (light mode — matches the openresearch.sh/qwen-maxrl reference)

Minimal, light, academic, generous whitespace, hairline borders, flat (almost no shadows).
Define these as CSS variables on `:root` and use them everywhere:

```css
--bg:            #ffffff;   /* main content background */
--bg-sidebar:    #fafafa;   /* sidebar panel background */
--bg-elevated:   #ffffff;
--bg-hover:      #f3f4f6;   /* row hover */
--accent-soft:   #eff6ff;   /* active row tint */
--text:          #0a0a0a;   /* primary near-black */
--text-muted:    #6b7280;   /* secondary/subtitles */
--border:        #e5e7eb;   /* dividers / hairlines */
--accent:        #2563eb;   /* primary blue */
--accent-hover:  #1d4ed8;
--status-running:#16a34a;   /* green - active */
--status-idle:   #9ca3af;   /* grey - idle */
--status-exited: #dc2626;   /* red - exited */
--radius:        8px;
--font-sans: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
--font-mono: "SF Mono", "JetBrains Mono", Menlo, Monaco, "Cascadia Code", monospace;
```

- Sidebar: ~280px wide, resizable is a bonus, hairline right border `--border`.
- Body font `--font-sans`; terminal & code use `--font-mono`.
- `.session-item`: rounded `--radius`, 10–12px padding, hover → `--bg-hover`,
  `.is-active` → `--accent-soft` background + a 2–3px `--accent` left border (or left bar).
- `.session-status`: an 8px dot; `running`→green (with a subtle pulse animation), `idle`→grey, `exited`→red.
- `#new-session-btn` and primary buttons: blue `--accent`, white text, rounded, hover `--accent-hover`.
- Title `Terminals` in the sidebar header: semibold, ~15px. Subtitles `--text-muted`, ~12px, truncate with ellipsis.

### xterm.js theme (renderer sets this on `new Terminal({ theme })`) — keep it light to match:
```js
theme: {
  background: "#ffffff", foreground: "#0a0a0a", cursor: "#2563eb",
  cursorAccent: "#ffffff", selectionBackground: "#dbeafe",
  black:"#0a0a0a", red:"#dc2626", green:"#16a34a", yellow:"#ca8a04",
  blue:"#2563eb", magenta:"#9333ea", cyan:"#0891b2", white:"#6b7280",
  brightBlack:"#9ca3af", brightRed:"#ef4444", brightGreen:"#22c55e",
  brightYellow:"#eab308", brightBlue:"#3b82f6", brightMagenta:"#a855f7",
  brightCyan:"#06b6d4", brightWhite:"#111111"
},
fontFamily: '"SF Mono","JetBrains Mono",Menlo,monospace', fontSize: 13
```

---

## 6. Loading xterm in the renderer (no bundler, secure mode)

`index.html` loads xterm via plain <script>/<link> tags pointing at node_modules
(NOT `require`, since nodeIntegration is false). UMD globals become available:
```html
<link rel="stylesheet" href="../node_modules/@xterm/xterm/css/xterm.css" />
<script src="../node_modules/@xterm/xterm/lib/xterm.js"></script>
<script src="../node_modules/@xterm/addon-fit/lib/addon-fit.js"></script>
<script src="../node_modules/@xterm/addon-web-links/lib/addon-web-links.js"></script>
<script src="renderer.js"></script>
```
Globals exposed: `window.Terminal`, `window.FitAddon.FitAddon`, `window.WebLinksAddon.WebLinksAddon`.
