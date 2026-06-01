// renderer.js — wires xterm.js terminals, the session sidebar, and IPC.
// Loaded as a plain <script>. Has access to:
//   window.termAPI                  (from preload contextBridge)
//   window.Terminal                 (xterm UMD)
//   window.FitAddon.FitAddon        (fit addon UMD)
//   window.WebLinksAddon.WebLinksAddon (web links addon UMD)
//
// No modules / no require.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants (from CONTRACT section 5)
  // ---------------------------------------------------------------------------

  // ---- ANSI palettes (one warm "cozy" set per light / dark family) ----
  // The terminal's background / foreground / cursor / selection are set per
  // theme below; these 16 ANSI slots are shared across the light (or dark)
  // themes so program colors stay legible on any cozy background.
  var ANSI_LIGHT = {
    black: "#3a322c", red: "#c2553f", green: "#6f9a5e", yellow: "#b5852f",
    blue: "#5a7d9a", magenta: "#9a6c8a", cyan: "#4f8a86", white: "#78716c",
    brightBlack: "#a8a29e", brightRed: "#cd5c46", brightGreen: "#7faa66",
    brightYellow: "#caa052", brightBlue: "#6f93ad", brightMagenta: "#b07fa0",
    brightCyan: "#5fa39e", brightWhite: "#2b2520"
  };
  var ANSI_DARK = {
    black: "#5b5048", red: "#e8765c", green: "#7fae6a", yellow: "#d6a85c",
    blue: "#86a9c4", magenta: "#c096b4", cyan: "#6fb8b2", white: "#cabfb2",
    brightBlack: "#8a7e72", brightRed: "#f0917a", brightGreen: "#97c47f",
    brightYellow: "#e6bd74", brightBlue: "#a0c2d8", brightMagenta: "#d4adc6",
    brightCyan: "#8acfc8", brightWhite: "#f3ece1"
  };

  // Build an xterm theme object from per-theme colors + a shared ANSI family.
  function mkXterm(bg, fg, cursor, sel, ansi) {
    var t = { background: bg, foreground: fg, cursor: cursor, cursorAccent: bg, selectionBackground: sel };
    for (var k in ansi) { if (Object.prototype.hasOwnProperty.call(ansi, k)) t[k] = ansi[k]; }
    return t;
  }

  // ---- Theme registry ----
  // id matches :root[data-theme="<id>"] in styles.css. `swatch` drives the
  // picker dot; `dark` flags the family; `xterm` keeps the terminal in sync.
  // All themes share the warm clay accent. Order = order shown in the picker.
  var THEMES = [
    { id: "auto",        label: "Auto",        swatch: "auto",    dark: null },
    { id: "pure-white",  label: "Pure White",  swatch: "#ffffff", dark: false, xterm: mkXterm("#ffffff", "#1c1917", "#d97757", "#f6d8c9", ANSI_LIGHT) },
    { id: "silver",      label: "Silver",      swatch: "#dcdce0", dark: false, xterm: mkXterm("#f4f4f5", "#2b2b2e", "#d97757", "#ecd6c8", ANSI_LIGHT) },
    { id: "mocha",       label: "Mocha",       swatch: "#c79e7f", dark: false, xterm: mkXterm("#f1e9e1", "#43342a", "#bf6b43", "#e3c9b3", ANSI_LIGHT) },
    { id: "pink",        label: "Pink",        swatch: "#f3c6cf", dark: false, xterm: mkXterm("#fdf3f4", "#4a2e34", "#d97757", "#f6d2d9", ANSI_LIGHT) },
    { id: "claude-cozy", label: "Claude Cozy", swatch: "#d97757", dark: false, xterm: mkXterm("#f0eee6", "#2e2a23", "#d97757", "#ecd3c2", ANSI_LIGHT) },
    { id: "dark",        label: "Dark",        swatch: "#1a1613", dark: true,  xterm: mkXterm("#1a1613", "#ece3d8", "#e08a63", "rgba(224,138,99,0.32)", ANSI_DARK) },
    { id: "grey-dark",   label: "Grey Dark",   swatch: "#3a3a38", dark: true,  xterm: mkXterm("#1f1f1e", "#e6e3de", "#e08a63", "rgba(224,138,99,0.32)", ANSI_DARK) }
  ];

  var THEME_BY_ID = {};
  THEMES.forEach(function (t) { THEME_BY_ID[t.id] = t; });

  var THEME_KEY = "tc-theme";       // localStorage: a theme id, or absent => "auto"
  var DEFAULT_LIGHT_ID = "pure-white";
  var DEFAULT_DARK_ID = "dark";

  // Does the OS currently prefer dark?
  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  // Stored explicit theme id, or null when following the system ("auto").
  function storedTheme() {
    try {
      var v = window.localStorage.getItem(THEME_KEY);
      return (v && v !== "auto" && THEME_BY_ID[v]) ? v : null;
    } catch (e) { return null; }
  }

  // What the user picked, as an id ("auto" when following the system).
  function currentSelectionId() {
    return storedTheme() || "auto";
  }

  // The concrete theme in effect right now (never "auto").
  function effectiveTheme() {
    var pref = storedTheme();
    if (pref) return THEME_BY_ID[pref];
    return THEME_BY_ID[systemPrefersDark() ? DEFAULT_DARK_ID : DEFAULT_LIGHT_ID];
  }

  function isDarkActive() {
    return !!effectiveTheme().dark;
  }

  // The xterm theme object matching the current effective theme.
  function currentXtermTheme() {
    return effectiveTheme().xterm;
  }

  // Apply the current theme to <html>, the picker button/menu, and every
  // live terminal.
  function applyThemeToDom() {
    var pref = storedTheme();
    var root = document.documentElement;
    if (pref) root.setAttribute("data-theme", pref);
    else root.removeAttribute("data-theme"); // follow the OS via the CSS media query

    updateThemeButton();
    refreshThemeMenu();

    // Re-theme every live terminal in place.
    var theme = currentXtermTheme();
    sessions.forEach(function (entry) {
      if (entry.term) {
        try { entry.term.options.theme = theme; } catch (e) {}
      }
    });
  }

  // Pick a theme by id ("auto" => follow the system).
  function setTheme(id) {
    try {
      if (id && id !== "auto") window.localStorage.setItem(THEME_KEY, id);
      else window.localStorage.removeItem(THEME_KEY);
    } catch (e) {}
    applyThemeToDom();
  }

  // ---- Theme picker popover (footer button -> swatch menu) ----
  var themeMenuEl = null;
  var themeMenuOpen = false;

  // The footer button reads as a dropdown trigger: [swatch] Theme name [chevron].
  function updateThemeButton() {
    if (!dom.themeToggle) return;
    var t = effectiveTheme();
    var selId = currentSelectionId();
    var isAuto = selId === "auto";
    dom.themeToggle.textContent = "";

    var sw = document.createElement("span");
    // When following the system, show the split "auto" swatch; otherwise the
    // active theme's solid swatch.
    sw.className = "theme-swatch" + (isAuto ? " is-auto" : (t.dark ? " on-dark" : ""));
    if (!isAuto) sw.style.background = t.swatch;
    dom.themeToggle.appendChild(sw);

    var label = document.createElement("span");
    label.className = "theme-picker-label";
    label.textContent = isAuto ? "Auto" : t.label;
    dom.themeToggle.appendChild(label);

    var caret = document.createElement("span");
    caret.className = "theme-picker-caret";
    caret.textContent = "▾"; // ▾
    caret.setAttribute("aria-hidden", "true");
    dom.themeToggle.appendChild(caret);

    var title = isAuto ? "Theme: Auto (" + t.label + ")" : "Theme: " + t.label;
    dom.themeToggle.title = title;
    dom.themeToggle.setAttribute("aria-label", title);
  }

  function buildThemeMenu() {
    var menu = document.createElement("div");
    menu.className = "theme-menu";
    menu.setAttribute("role", "menu");
    THEMES.forEach(function (t) {
      var opt = document.createElement("button");
      opt.type = "button";
      opt.className = "theme-option";
      opt.setAttribute("role", "menuitemradio");
      opt.setAttribute("data-theme-id", t.id);

      var sw = document.createElement("span");
      sw.className = "theme-swatch" + (t.swatch === "auto" ? " is-auto" : (t.dark ? " on-dark" : ""));
      if (t.swatch !== "auto") sw.style.background = t.swatch;

      var label = document.createElement("span");
      label.className = "theme-option-label";
      label.textContent = t.label;

      var check = document.createElement("span");
      check.className = "theme-option-check";
      check.textContent = "✓";

      opt.appendChild(sw);
      opt.appendChild(label);
      opt.appendChild(check);
      opt.addEventListener("click", function () {
        setTheme(t.id);
        closeThemeMenu();
      });
      menu.appendChild(opt);
    });
    return menu;
  }

  function refreshThemeMenu() {
    if (!themeMenuEl) return;
    var sel = currentSelectionId();
    var opts = themeMenuEl.querySelectorAll(".theme-option");
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].getAttribute("data-theme-id") === sel;
      opts[i].classList.toggle("is-selected", on);
      opts[i].setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  function onThemeDocMouseDown(e) {
    if (!themeMenuEl) return;
    if (themeMenuEl.contains(e.target)) return;
    if (dom.themeToggle && (e.target === dom.themeToggle || dom.themeToggle.contains(e.target))) return;
    closeThemeMenu();
  }
  function onThemeKeydown(e) {
    if (e.key === "Escape") {
      closeThemeMenu();
      if (dom.themeToggle) dom.themeToggle.focus();
    }
  }

  function openThemeMenu() {
    if (!dom.themeToggle) return;
    if (!themeMenuEl) {
      themeMenuEl = buildThemeMenu();
      var host = dom.sidebarFooter || dom.themeToggle.parentNode;
      if (host) host.appendChild(themeMenuEl);
    }
    refreshThemeMenu();
    themeMenuEl.classList.add("is-open");
    themeMenuOpen = true;
    dom.themeToggle.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onThemeDocMouseDown, true);
    document.addEventListener("keydown", onThemeKeydown, true);
  }

  function closeThemeMenu() {
    if (themeMenuEl) themeMenuEl.classList.remove("is-open");
    themeMenuOpen = false;
    if (dom.themeToggle) dom.themeToggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onThemeDocMouseDown, true);
    document.removeEventListener("keydown", onThemeKeydown, true);
  }

  function toggleThemeMenu() {
    if (themeMenuOpen) closeThemeMenu();
    else openThemeMenu();
  }

  // ---------------------------------------------------------------------------
  // Layout mode: "single" (one active terminal) vs "grid" (window mode — all
  // sessions tiled at once so several can be watched/prompted together).
  // ---------------------------------------------------------------------------

  var LAYOUT_KEY = "tc-layout"; // localStorage: "single" | "grid"

  function layoutMode() {
    try {
      return window.localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "single";
    } catch (e) { return "single"; }
  }
  function isGrid() { return layoutMode() === "grid"; }

  // Fit every live terminal (used in grid mode + on layout change).
  function fitAll() {
    sessions.forEach(function (entry) { safeFit(entry); });
  }

  // Debounced refit — lets the browser apply the new layout before measuring.
  var fitAllTimer = null;
  function scheduleFitAll() {
    if (fitAllTimer) clearTimeout(fitAllTimer);
    fitAllTimer = setTimeout(function () {
      fitAllTimer = null;
      fitAll();
    }, 60);
  }

  // Reflect the current layout in the DOM + toggle button, then refit.
  function applyLayout() {
    var grid = isGrid();
    if (dom.terminals) dom.terminals.classList.toggle("is-grid", grid);
    if (dom.layoutToggle) {
      dom.layoutToggle.classList.toggle("is-on", grid);
      dom.layoutToggle.textContent = grid ? "▭ Single" : "▦ Grid";
      dom.layoutToggle.title = grid
        ? "Switch to single-terminal mode"
        : "Switch to window (grid) mode";
    }
    scheduleFitAll();
  }

  function setLayout(mode) {
    try { window.localStorage.setItem(LAYOUT_KEY, mode); } catch (e) {}
    applyLayout();
  }
  function toggleLayout() { setLayout(isGrid() ? "single" : "grid"); }

  var FONT_FAMILY = '"SF Mono","JetBrains Mono",Menlo,monospace';
  var FONT_SIZE = 13;
  var SCROLLBACK = 5000;
  var RESIZE_DEBOUNCE_MS = 80;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // id -> { session, term, fitAddon, el, row }
  var sessions = new Map();

  // Currently focused session id (or null).
  var activeId = null;

  // DOM element handles (resolved on DOMContentLoaded).
  var dom = {};

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Compute cols/rows from the active terminal's fit addon, if available.
  function computeSize() {
    if (activeId && sessions.has(activeId)) {
      var entry = sessions.get(activeId);
      try {
        var dims = entry.fitAddon.proposeDimensions();
        if (dims && dims.cols && dims.rows) {
          return { cols: dims.cols, rows: dims.rows };
        }
      } catch (e) { /* fall through to default */ }
    }
    return { cols: 80, rows: 24 };
  }

  // Update the "N session(s)" footer and toggle the empty-state.
  function updateSessionCount() {
    var n = sessions.size;
    if (dom.sessionCount) {
      dom.sessionCount.textContent = n + " session" + (n === 1 ? "" : "s");
    }
    updateEmptyState();
  }

  // Empty-state is visible only when there are no sessions at all.
  function updateEmptyState() {
    if (!dom.emptyState) return;
    var show = sessions.size === 0;
    dom.emptyState.style.display = show ? "" : "none";
  }

  // Safely fit a terminal entry (guards against detached/invisible elements).
  function safeFit(entry) {
    if (!entry || !entry.fitAddon) return;
    try {
      entry.fitAddon.fit();
    } catch (e) { /* element may not be measurable yet */ }
  }

  // ---------------------------------------------------------------------------
  // Sidebar row construction (markup per CONTRACT section 4)
  // ---------------------------------------------------------------------------

  function buildRow(session) {
    var li = document.createElement("li");
    li.className = "session-item";
    li.setAttribute("data-id", session.id);

    var status = document.createElement("span");
    status.className = "session-status";
    status.setAttribute("data-state", session.state || "idle");

    var icon = document.createElement("span");
    icon.className = "session-icon";
    icon.textContent = "›_"; // "›_"

    var meta = document.createElement("div");
    meta.className = "session-meta";

    var title = document.createElement("div");
    title.className = "session-title";
    title.textContent = session.title || "";

    var subtitle = document.createElement("div");
    subtitle.className = "session-subtitle";
    subtitle.textContent = session.cwd || "";

    meta.appendChild(title);
    meta.appendChild(subtitle);

    var close = document.createElement("button");
    close.className = "session-close";
    close.title = "Close";
    close.textContent = "×"; // "×"

    li.appendChild(status);
    li.appendChild(icon);
    li.appendChild(meta);
    li.appendChild(close);

    // Row click → focus the session.
    li.addEventListener("click", function () {
      focusSession(session.id);
    });

    // Close button → kill the session (don't bubble to the row click).
    close.addEventListener("click", function (ev) {
      ev.stopPropagation();
      killSession(session.id);
    });

    return li;
  }

  // ---------------------------------------------------------------------------
  // Mount: create the xterm instance + sidebar row for a session.
  // ---------------------------------------------------------------------------

  function mount(session) {
    // 1. Tile = header (shown in grid mode) + body (xterm host).
    var div = document.createElement("div");
    div.className = "term-instance";
    div.setAttribute("data-id", session.id);

    var header = document.createElement("div");
    header.className = "term-header";

    var headerTitle = document.createElement("span");
    headerTitle.className = "term-header-title";
    headerTitle.textContent = session.title || "";

    var headerClose = document.createElement("button");
    headerClose.className = "term-header-close";
    headerClose.title = "Close";
    headerClose.textContent = "×";

    header.appendChild(headerTitle);
    header.appendChild(headerClose);

    var body = document.createElement("div");
    body.className = "term-body";

    div.appendChild(header);
    div.appendChild(body);
    dom.terminals.appendChild(div);

    // 2. xterm instance using the current (light/dark) theme.
    var term = new window.Terminal({
      theme: currentXtermTheme(),
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      cursorBlink: true,
      convertEol: false,
      scrollback: SCROLLBACK
    });

    var fitAddon = new window.FitAddon.FitAddon();
    var webLinksAddon = new window.WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(body);
    try { fitAddon.fit(); } catch (e) { /* not measurable yet */ }

    // 3. Wire keystrokes and resize to the pty.
    term.onData(function (data) {
      window.termAPI.input(session.id, data);
    });
    term.onResize(function (size) {
      window.termAPI.resize(session.id, size.cols, size.rows);
    });

    // 4. Clicking a tile focuses its session (matters in grid mode).
    div.addEventListener("mousedown", function () {
      focusSession(session.id);
    });
    // Per-tile close button (grid mode).
    headerClose.addEventListener("click", function (ev) {
      ev.stopPropagation();
      killSession(session.id);
    });

    // 5. Sidebar row.
    var row = buildRow(session);
    dom.sessionList.appendChild(row);

    // 6. Store everything.
    sessions.set(session.id, {
      session: session,
      term: term,
      fitAddon: fitAddon,
      el: div,
      body: body,
      row: row,
      headerTitle: headerTitle
    });

    // 7. Bookkeeping. A new tile reflows the grid → refit all tiles.
    updateSessionCount();
    if (isGrid()) scheduleFitAll();
  }

  // ---------------------------------------------------------------------------
  // newSession: create in main, mount, focus.
  // ---------------------------------------------------------------------------

  function newSession() {
    var size = computeSize();
    return window.termAPI.create({ cols: size.cols, rows: size.rows })
      .then(function (session) {
        mount(session);
        focusSession(session.id);
        return session;
      })
      .catch(function (err) {
        console.error("Failed to create session:", err);
      });
  }

  // ---------------------------------------------------------------------------
  // focusSession: make the given session the active one.
  // ---------------------------------------------------------------------------

  function focusSession(id) {
    if (!sessions.has(id)) return;
    activeId = id;

    // Toggle is-active on all rows and term divs.
    sessions.forEach(function (entry, sid) {
      var active = sid === id;
      if (entry.el) entry.el.classList.toggle("is-active", active);
      if (entry.row) entry.row.classList.toggle("is-active", active);
    });

    var entry = sessions.get(id);

    // Update the topbar title.
    if (dom.activeTitle) {
      dom.activeTitle.textContent = entry.session.title || "";
    }

    // Hint main which session is focused.
    window.termAPI.focus(id);

    // Fit + focus the active terminal.
    safeFit(entry);
    if (entry.term) entry.term.focus();

    // There is an active terminal now → hide empty-state.
    updateEmptyState();
    if (dom.emptyState) dom.emptyState.style.display = "none";
  }

  // ---------------------------------------------------------------------------
  // killSession: kill in main, tear down locally.
  // ---------------------------------------------------------------------------

  function killSession(id) {
    if (!sessions.has(id)) return;

    return window.termAPI.kill(id)
      .catch(function (err) {
        console.error("Failed to kill session:", err);
      })
      .then(function () {
        var entry = sessions.get(id);
        if (!entry) return;

        // Dispose xterm and detach DOM.
        try { if (entry.term) entry.term.dispose(); } catch (e) {}
        if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
        if (entry.row && entry.row.parentNode) entry.row.parentNode.removeChild(entry.row);

        sessions.delete(id);

        // If the killed session was active, pick another or go empty.
        if (activeId === id) {
          activeId = null;
          var next = sessions.keys().next();
          if (!next.done) {
            focusSession(next.value);
          } else {
            // No sessions left.
            if (dom.activeTitle) dom.activeTitle.textContent = "No terminal";
            if (dom.emptyState) dom.emptyState.style.display = "";
          }
        }

        updateSessionCount();
        // Removing a tile reflows the grid → refit remaining tiles.
        if (isGrid()) scheduleFitAll();
      });
  }

  // ---------------------------------------------------------------------------
  // Filtering the sidebar by title/subtitle substring.
  // ---------------------------------------------------------------------------

  function applyFilter() {
    var q = (dom.sessionFilter && dom.sessionFilter.value || "").trim().toLowerCase();
    sessions.forEach(function (entry) {
      var row = entry.row;
      if (!row) return;
      if (!q) {
        row.style.display = "";
        return;
      }
      var titleEl = row.querySelector(".session-title");
      var subtitleEl = row.querySelector(".session-subtitle");
      var title = (titleEl && titleEl.textContent || "").toLowerCase();
      var subtitle = (subtitleEl && subtitleEl.textContent || "").toLowerCase();
      var match = title.indexOf(q) !== -1 || subtitle.indexOf(q) !== -1;
      row.style.display = match ? "" : "none";
    });
  }

  // ---------------------------------------------------------------------------
  // IPC event handlers (registered once).
  // ---------------------------------------------------------------------------

  function registerIpcHandlers() {
    // pty output → write to the matching terminal.
    window.termAPI.onData(function (payload) {
      var entry = sessions.get(payload.id);
      if (entry && entry.term) entry.term.write(payload.data);
    });

    // process exit → mark row exited, print a dim notice, keep the row.
    window.termAPI.onExit(function (payload) {
      var entry = sessions.get(payload.id);
      if (!entry) return;
      if (entry.session) entry.session.state = "exited";
      var status = entry.row && entry.row.querySelector(".session-status");
      if (status) status.setAttribute("data-state", "exited");
      if (entry.term) {
        // Dim (SGR 2) notice; reset afterwards.
        entry.term.write(
          "\r\n\x1b[2m[process exited (" + payload.exitCode + ")]\x1b[0m\r\n"
        );
      }
      // Do NOT auto-remove — let the user close it.
    });

    // state machine transitions → update the row badge.
    window.termAPI.onState(function (payload) {
      var entry = sessions.get(payload.id);
      if (!entry) return;
      if (entry.session) entry.session.state = payload.state;
      var status = entry.row && entry.row.querySelector(".session-status");
      if (status) status.setAttribute("data-state", payload.state);
    });

    // title updates → update session, row title, and topbar if active.
    window.termAPI.onTitle(function (payload) {
      var entry = sessions.get(payload.id);
      if (!entry) return;
      if (entry.session) entry.session.title = payload.title;
      var titleEl = entry.row && entry.row.querySelector(".session-title");
      if (titleEl) titleEl.textContent = payload.title;
      if (entry.headerTitle) entry.headerTitle.textContent = payload.title;
      if (payload.id === activeId && dom.activeTitle) {
        dom.activeTitle.textContent = payload.title;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Resize handling (debounced) — fit the ACTIVE terminal.
  // ---------------------------------------------------------------------------

  var resizeTimer = null;
  function onWindowResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (isGrid()) {
        fitAll();
      } else if (activeId && sessions.has(activeId)) {
        safeFit(sessions.get(activeId));
      }
    }, RESIZE_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  function init() {
    // Resolve DOM handles.
    dom.sessionList = document.getElementById("session-list");
    dom.terminals = document.getElementById("terminals");
    dom.emptyState = document.getElementById("empty-state");
    dom.activeTitle = document.getElementById("active-title");
    dom.sessionCount = document.getElementById("session-count");
    dom.sessionFilter = document.getElementById("session-filter");
    dom.newSessionBtn = document.getElementById("new-session-btn");
    dom.killActiveBtn = document.getElementById("kill-active");
    dom.themeToggle = document.getElementById("theme-toggle");
    dom.sidebarFooter = document.querySelector(".sidebar-footer");
    dom.layoutToggle = document.getElementById("layout-toggle");

    // Apply the saved/system theme + saved layout before any terminals exist.
    applyThemeToDom();
    applyLayout();

    // Clear any .is-template example rows from the session list.
    if (dom.sessionList) {
      var templates = dom.sessionList.querySelectorAll(".is-template");
      for (var i = 0; i < templates.length; i++) {
        templates[i].parentNode.removeChild(templates[i]);
      }
    }

    // Register IPC handlers exactly once.
    registerIpcHandlers();

    // Wire UI controls.
    if (dom.newSessionBtn) {
      dom.newSessionBtn.addEventListener("click", function () { newSession(); });
    }
    if (dom.killActiveBtn) {
      dom.killActiveBtn.addEventListener("click", function () {
        if (activeId) killSession(activeId);
      });
    }
    if (dom.sessionFilter) {
      dom.sessionFilter.addEventListener("input", applyFilter);
    }
    if (dom.themeToggle) {
      dom.themeToggle.addEventListener("click", toggleThemeMenu);
    }
    if (dom.layoutToggle) {
      dom.layoutToggle.addEventListener("click", toggleLayout);
    }

    // When following the system theme (no explicit choice), react to OS changes live.
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onSystemThemeChange = function () {
        if (!storedTheme()) applyThemeToDom();
      };
      if (mq.addEventListener) mq.addEventListener("change", onSystemThemeChange);
      else if (mq.addListener) mq.addListener(onSystemThemeChange); // older API
    }

    window.addEventListener("resize", onWindowResize);

    // Initialize count / empty-state.
    updateSessionCount();

    // Auto-create one session if there are none at startup.
    if (sessions.size === 0) {
      newSession();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // Script may load after DOMContentLoaded already fired.
    init();
  }
})();
