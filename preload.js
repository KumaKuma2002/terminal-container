// preload.js — contextBridge between the renderer and the main process.
//
// Runs in an isolated context (contextIsolation: true). It exposes exactly the
// `window.termAPI` shape defined in CONTRACT.md §3 and nothing else. The
// renderer never touches ipcRenderer directly.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Subscribe to a main→renderer event channel and return an unsubscribe
 * function. The raw IpcRendererEvent is stripped so callbacks only ever see
 * the payload, matching the contract's `cb(payload)` signature.
 *
 * @param {string} channel
 * @param {(payload: any) => void} cb
 * @returns {() => void} unsubscribe
 */
function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('termAPI', {
  // --- Invoke (returns Promise) ---
  create: (opts) => ipcRenderer.invoke('term:create', opts),
  list: () => ipcRenderer.invoke('term:list'),
  kill: (id) => ipcRenderer.invoke('term:kill', { id }),

  // --- Send (fire-and-forget) ---
  input: (id, data) => ipcRenderer.send('term:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  focus: (id) => ipcRenderer.send('term:focus', { id }),

  // --- Events (each returns an unsubscribe function) ---
  onData: (cb) => subscribe('term:data', cb),
  onExit: (cb) => subscribe('term:exit', cb),
  onState: (cb) => subscribe('term:state', cb),
  onTitle: (cb) => subscribe('term:title', cb),
});
