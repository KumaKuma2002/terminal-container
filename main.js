// main.js — Electron main process for the Terminal Container app.
//
// Responsibilities (per CONTRACT.md):
//   - Create a secure BrowserWindow and load the renderer.
//   - Spawn real shells via node-pty and track them as Sessions.
//   - Implement every IPC channel in the contract.
//   - Own the activity state machine (running / idle / exited) and emit
//     term:data / term:state / term:exit / term:title events to the renderer.

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const pty = require('node-pty');

// ---------------------------------------------------------------------------
// Configuration / constants
// ---------------------------------------------------------------------------

// How long (ms) the pty must stay quiet before a session is considered "idle".
const IDLE_MS = 600;

// Default shell + cwd used when the renderer does not specify them.
const DEFAULT_SHELL =
  process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
const DEFAULT_CWD = os.homedir();

// OSC window-title sequence:  ESC ] 0;TEXT BEL   or   ESC ] 2;TEXT BEL
// Terminator may be BEL (\x07) or ST (ESC \). The TEXT excludes BEL/ESC so a
// partial chunk that has not yet received its terminator simply won't match
// (we wait for the next chunk rather than crashing or mis-parsing).
const OSC_TITLE_RE = /\x1b\]([02]);([^\x07\x1b]*)(?:\x07|\x1b\\)/;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Map of sessionId -> {
 *   pty: IPty,
 *   session: Session,   // the plain object shared over IPC (see contract §1)
 *   idleTimer: NodeJS.Timeout | null
 * }
 */
const sessions = new Map();

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Id of the session the renderer last reported as focused (hint only). */
let focusedId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to the renderer's webContents, but only if the window and its
 * webContents are still alive. Safe to call during teardown.
 */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const wc = mainWindow.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, payload);
    }
  }
}

/**
 * Transition a session to a new state and notify the renderer — but only emit
 * an event if the state actually changed.
 */
function setState(entry, state) {
  if (!entry || entry.session.state === state) return;
  entry.session.state = state;
  sendToRenderer('term:state', { id: entry.session.id, state });
}

/**
 * Clear any pending idle timer on an entry.
 */
function clearIdleTimer(entry) {
  if (entry && entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

/**
 * Restart the idle countdown: the session is "running" right now, and after
 * IDLE_MS of silence it flips to "idle".
 */
function bumpActivity(entry) {
  clearIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    // Only fall back to idle if the process is still alive.
    if (entry.session.state === 'running') {
      setState(entry, 'idle');
    }
  }, IDLE_MS);
}

/**
 * Look for an OSC 0/2 title sequence in a data chunk and, if present, update
 * the session title and notify the renderer. Uses the LAST match in the chunk
 * so the most recent title wins. Wrapped so a malformed chunk can never crash.
 */
function maybeUpdateTitle(entry, data) {
  try {
    let match;
    let title = null;
    const re = new RegExp(OSC_TITLE_RE.source, 'g');
    while ((match = re.exec(data)) !== null) {
      title = match[2];
    }
    if (title !== null && title.length > 0 && title !== entry.session.title) {
      entry.session.title = title;
      sendToRenderer('term:title', { id: entry.session.id, title });
    }
  } catch {
    // Never let title parsing take down a session.
  }
}

/**
 * Build the initial display title for a session, e.g. "zsh — myproject".
 */
function initialTitle(shell, cwd) {
  const base = path.basename(cwd) || cwd;
  return `${path.basename(shell)} — ${base}`;
}

function isAllowedPreviewUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') return true;
    const startUrl = pathToFileURL(path.join(__dirname, 'renderer', 'preview-start.html')).href;
    return url.href === startUrl;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// pty wiring
// ---------------------------------------------------------------------------

/**
 * Attach data/exit listeners that drive the activity state machine.
 */
function wirePty(entry) {
  const { pty: ptyProc, session } = entry;

  ptyProc.onData((data) => {
    // 1. Forward raw output to the renderer.
    sendToRenderer('term:data', { id: session.id, data });

    // 2. Any output means the session is active again.
    if (session.state !== 'running') {
      setState(entry, 'running');
    }

    // 3. (Re)arm the idle timer.
    bumpActivity(entry);

    // 4. Best-effort OSC title parsing.
    maybeUpdateTitle(entry, data);
  });

  ptyProc.onExit(({ exitCode }) => {
    clearIdleTimer(entry);
    setState(entry, 'exited');
    sendToRenderer('term:exit', { id: session.id, exitCode });
    // Keep the entry in the map so term:list still reports the exited session
    // until the renderer explicitly kills it. The pty process itself is gone.
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// term:create — spawn a pty and return a Session.
ipcMain.handle('term:create', (_event, opts = {}) => {
  const shell = opts.shell || DEFAULT_SHELL;
  const cwd = opts.cwd || DEFAULT_CWD;
  const cols = opts.cols || 80;
  const rows = opts.rows || 24;

  const ptyProc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env,
  });

  const id = crypto.randomUUID();

  /** @type {Session} */
  const session = {
    id,
    title: initialTitle(shell, cwd),
    cwd,
    shell,
    state: 'running',
    createdAt: Date.now(),
  };

  const entry = { pty: ptyProc, session, idleTimer: null };
  sessions.set(id, entry);

  wirePty(entry);
  // Arm the idle timer immediately so a quiet shell settles to "idle".
  bumpActivity(entry);

  return session;
});

// term:list — return Session objects only (never the pty handles).
ipcMain.handle('term:list', () => {
  return Array.from(sessions.values()).map((entry) => entry.session);
});

// term:kill — terminate the pty and drop the session.
ipcMain.handle('term:kill', (_event, { id } = {}) => {
  const entry = sessions.get(id);
  if (entry) {
    clearIdleTimer(entry);
    try {
      entry.pty.kill();
    } catch {
      // Process may already be gone; ignore.
    }
    sessions.delete(id);
  }
  if (focusedId === id) focusedId = null;
  return { ok: true };
});

// term:input — write keystrokes into the pty.
ipcMain.on('term:input', (_event, { id, data } = {}) => {
  const entry = sessions.get(id);
  if (entry) {
    try {
      entry.pty.write(data);
    } catch {
      // Writing to a dead pty throws; ignore.
    }
  }
});

// term:resize — resize the pty's terminal dimensions.
ipcMain.on('term:resize', (_event, { id, cols, rows } = {}) => {
  const entry = sessions.get(id);
  if (entry && cols > 0 && rows > 0) {
    try {
      entry.pty.resize(cols, rows);
    } catch {
      // Resizing a dead pty throws; ignore.
    }
  }
});

// term:focus — remember which session the renderer says is focused (hint only).
ipcMain.on('term:focus', (_event, { id } = {}) => {
  focusedId = id;
});

// ---------------------------------------------------------------------------
// Window + app lifecycle
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    // Let macOS provide the real blurred desktop material beneath the CSS
    // glass layers. The transparent fallback is harmless on other platforms.
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 24, y: 22 } : undefined,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    roundedCorners: true,
    hasShadow: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Web previews run as isolated guests: no Node, no preload bridge, no
  // arbitrary file:// navigation, and no surprise popup windows.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;

    if (!isAllowedPreviewUrl(params.src)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    guestContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    guestContents.on('will-navigate', (event, url) => {
      if (!isAllowedPreviewUrl(url)) event.preventDefault();
    });
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Kill every live pty. Called on quit so no orphaned shells linger.
 */
function killAllPtys() {
  for (const entry of sessions.values()) {
    clearIdleTimer(entry);
    try {
      entry.pty.kill();
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

app.whenReady().then(() => {
  createWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (on every platform — simple, per contract).
app.on('window-all-closed', () => {
  app.quit();
});

// Ensure no shells survive the app.
app.on('before-quit', killAllPtys);
app.on('will-quit', killAllPtys);
