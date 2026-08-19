// native-bridge.js — WKWebView host bridge.
//
// Defines the same window.termAPI shape as Electron's preload.js, backed by
// window.webkit.messageHandlers.term. In Electron the guard below exits
// immediately and the preload's termAPI stays in charge; in the native host
// (native/main.swift) this file IS the bridge.

(function () {
  "use strict";

  if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.term) {
    return; // Electron (or plain browser) — preload.js provides termAPI
  }

  var nextRef = 1;
  var pendingInvokes = {};
  var listeners = {};

  function post(message) {
    try { window.webkit.messageHandlers.term.postMessage(message); } catch (e) {}
  }

  function invoke(channel, payload) {
    return new Promise(function (resolve) {
      var ref = String(nextRef++);
      pendingInvokes[ref] = resolve;
      post({ kind: "invoke", ref: ref, channel: channel, payload: payload || null });
    });
  }

  function subscribe(channel) {
    return function (cb) {
      if (!listeners[channel]) listeners[channel] = [];
      listeners[channel].push(cb);
      return function () {
        var arr = listeners[channel] || [];
        var i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      };
    };
  }

  // Native -> renderer entry points (called via evaluateJavaScript).
  window.__nativeReply = function (ref, result) {
    var resolve = pendingInvokes[ref];
    if (resolve) {
      delete pendingInvokes[ref];
      resolve(result);
    }
  };

  window.__nativeEvent = function (channel, payload) {
    var arr = listeners[channel] || [];
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) {}
    }
  };

  window.termAPI = {
    // WKWebView has no <webview> tag — the renderer hides the preview button.
    capabilities: { preview: false },

    // Invoke (returns Promise)
    create: function (opts) { return invoke("term:create", opts); },
    list: function () { return invoke("term:list", null); },
    kill: function (id) { return invoke("term:kill", { id: id }); },

    // Send (fire-and-forget)
    input: function (id, data) { post({ kind: "send", channel: "term:input", payload: { id: id, data: data } }); },
    resize: function (id, cols, rows) { post({ kind: "send", channel: "term:resize", payload: { id: id, cols: cols, rows: rows } }); },
    focus: function (id) { post({ kind: "send", channel: "term:focus", payload: { id: id } }); },

    // Events (each returns an unsubscribe function)
    onData: subscribe("term:data"),
    onExit: subscribe("term:exit"),
    onState: subscribe("term:state"),
    onTitle: subscribe("term:title")
  };
})();
