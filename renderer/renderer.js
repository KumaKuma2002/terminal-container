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
    // Keep the terminal canvas clear so the native/CSS glass remains visible.
    // `bg` is retained for readable text inside the block cursor.
    var t = { background: "rgba(0,0,0,0)", foreground: fg, cursor: cursor, cursorAccent: bg, selectionBackground: sel };
    for (var k in ansi) { if (Object.prototype.hasOwnProperty.call(ansi, k)) t[k] = ansi[k]; }
    return t;
  }

  // ---- Theme registry ----
  // id matches :root[data-theme="<id>"] in styles.css. `swatch` drives the
  // picker dot; `dark` flags the family; `xterm` keeps the terminal in sync.
  // Two light themes (Pure White, Silver); every other theme sits on a dark or
  // grey base with its own hue as the accent. Order = order shown in the picker.
  var THEMES = [
    { id: "auto",        label: "Auto",        swatch: "auto",    dark: null },
    { id: "pure-white",  label: "Pure White",  swatch: "#ffffff", dark: false, xterm: mkXterm("#ffffff", "#1c1917", "#d97757", "#f6d8c9", ANSI_LIGHT) },
    { id: "silver",      label: "Silver",      swatch: "#dcdce0", dark: false, xterm: mkXterm("#f4f4f5", "#2b2b2e", "#d97757", "#ecd6c8", ANSI_LIGHT) },
    { id: "claude-cozy", label: "Claude Cozy", swatch: "#d97757", dark: true,  xterm: mkXterm("#1f1812", "#f0e6d8", "#e08a63", "rgba(224,138,99,0.32)", ANSI_DARK) },
    { id: "mocha",       label: "Mocha",       swatch: "#c89060", dark: true,  xterm: mkXterm("#211913", "#ece0d2", "#d39a6a", "rgba(211,154,106,0.30)", ANSI_DARK) },
    { id: "matcha",      label: "Matcha",      swatch: "#8fae5d", dark: true,  xterm: mkXterm("#181d16", "#e6ecdb", "#a3c46e", "rgba(163,196,110,0.30)", ANSI_DARK) },
    { id: "pink",        label: "Pink",        swatch: "#d98aa0", dark: true,  xterm: mkXterm("#201a1d", "#ece0e4", "#e090a6", "rgba(224,144,166,0.30)", ANSI_DARK) },
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
    closeFontMenu();
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
  // Font picker popover (footer button -> size stepper + font list). Mirrors
  // the theme picker: one open menu at a time, Escape/outside to close.
  // ---------------------------------------------------------------------------

  var fontMenuEl = null;
  var fontMenuOpen = false;

  // The footer button reads [Ag] Font · size [chevron]; the glyph previews
  // the active font itself.
  function updateFontButton() {
    if (!dom.fontToggle) return;
    var f = currentFont();
    var size = currentFontSize();
    dom.fontToggle.textContent = "";

    var glyph = document.createElement("span");
    glyph.className = "font-picker-glyph";
    glyph.style.fontFamily = f.stack;
    glyph.textContent = "Ag";
    dom.fontToggle.appendChild(glyph);

    var label = document.createElement("span");
    label.className = "font-picker-label";
    label.textContent = f.short + " · " + size;
    dom.fontToggle.appendChild(label);

    var caret = document.createElement("span");
    caret.className = "theme-picker-caret";
    caret.textContent = "▾";
    caret.setAttribute("aria-hidden", "true");
    dom.fontToggle.appendChild(caret);

    var title = "Terminal font: " + f.label + " " + size + "px";
    dom.fontToggle.title = title;
    dom.fontToggle.setAttribute("aria-label", title);
  }

  function buildFontMenu() {
    var menu = document.createElement("div");
    menu.className = "font-menu";
    menu.setAttribute("role", "menu");

    // Size stepper: Size  − [13]  +
    var sizeRow = document.createElement("div");
    sizeRow.className = "font-size-row";

    var sizeLabel = document.createElement("span");
    sizeLabel.className = "font-size-label";
    sizeLabel.textContent = "Size";

    function stepBtn(dir, glyph, label) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "font-size-step";
      b.setAttribute("data-dir", dir);
      b.title = label;
      b.setAttribute("aria-label", label);
      b.textContent = glyph;
      b.addEventListener("click", function () {
        setFontSize(currentFontSize() + Number(dir));
      });
      return b;
    }

    var sizeValue = document.createElement("span");
    sizeValue.className = "font-size-value";

    sizeRow.appendChild(sizeLabel);
    sizeRow.appendChild(stepBtn("-1", "−", "Smaller font"));
    sizeRow.appendChild(sizeValue);
    sizeRow.appendChild(stepBtn("1", "+", "Larger font"));
    menu.appendChild(sizeRow);

    FONTS.forEach(function (f) {
      var opt = document.createElement("button");
      opt.type = "button";
      opt.className = "font-option";
      opt.setAttribute("role", "menuitemradio");
      opt.setAttribute("data-font-id", f.id);

      var name = document.createElement("span");
      name.className = "font-option-name";
      name.style.fontFamily = f.stack;
      name.textContent = f.label;

      var sample = document.createElement("span");
      sample.className = "font-option-sample";
      sample.style.fontFamily = f.stack;
      sample.textContent = "›_ curl --cozy 0123";

      var meta = document.createElement("span");
      meta.className = "font-option-meta";
      meta.appendChild(name);
      meta.appendChild(sample);

      var check = document.createElement("span");
      check.className = "theme-option-check";
      check.textContent = "✓";

      opt.appendChild(meta);
      opt.appendChild(check);
      opt.addEventListener("click", function () {
        setFont(f.id);
        refreshFontMenu();
      });
      menu.appendChild(opt);
    });
    return menu;
  }

  function refreshFontMenu() {
    if (!fontMenuEl) return;
    var sel = storedFontId();
    var opts = fontMenuEl.querySelectorAll(".font-option");
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].getAttribute("data-font-id") === sel;
      opts[i].classList.toggle("is-selected", on);
      opts[i].setAttribute("aria-checked", on ? "true" : "false");
    }
    var value = fontMenuEl.querySelector(".font-size-value");
    if (value) value.textContent = String(currentFontSize());
  }

  function onFontDocMouseDown(e) {
    if (!fontMenuEl) return;
    if (fontMenuEl.contains(e.target)) return;
    if (dom.fontToggle && (e.target === dom.fontToggle || dom.fontToggle.contains(e.target))) return;
    closeFontMenu();
  }
  function onFontKeydown(e) {
    if (e.key === "Escape") {
      closeFontMenu();
      if (dom.fontToggle) dom.fontToggle.focus();
    }
  }

  function openFontMenu() {
    if (!dom.fontToggle) return;
    closeThemeMenu();
    if (!fontMenuEl) {
      fontMenuEl = buildFontMenu();
      var host = dom.sidebarFooter || dom.fontToggle.parentNode;
      if (host) host.appendChild(fontMenuEl);
    }
    refreshFontMenu();
    fontMenuEl.classList.add("is-open");
    fontMenuOpen = true;
    dom.fontToggle.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onFontDocMouseDown, true);
    document.addEventListener("keydown", onFontKeydown, true);
  }

  function closeFontMenu() {
    if (fontMenuEl) fontMenuEl.classList.remove("is-open");
    fontMenuOpen = false;
    if (dom.fontToggle) dom.fontToggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onFontDocMouseDown, true);
    document.removeEventListener("keydown", onFontKeydown, true);
  }

  function toggleFontMenu() {
    if (fontMenuOpen) closeFontMenu();
    else openFontMenu();
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

  // ---- Terminal font registry ----
  // Seven faces, seven distinct styles — everything else was cut. System
  // faces need no download; web faces arrive via the Google Fonts <link> in
  // index.html and are awaited in setFont before being applied.
  // NOTE: "Apple Braille" contains ONLY braille dot glyphs (no Latin) —
  // normal text falls through to SF Mono while braille output (spinners,
  // progress bars) renders as authentic dots.
  var FONTS = [
    { id: "sf-mono",    label: "SF Mono",       short: "SF Mono",    stack: '"SF Mono","JetBrains Mono",Menlo,monospace' },
    { id: "braille",    label: "Apple Braille", short: "Braille",    stack: '"Apple Braille","SF Mono",Menlo,monospace' },
    { id: "noteworthy", label: "Noteworthy",    short: "Noteworthy", stack: '"Noteworthy","SF Mono",Menlo,monospace' },
    { id: "monaco",     label: "Monaco",        short: "Monaco",     stack: 'Monaco,Menlo,monospace' },
    { id: "cutive",     label: "Cutive Mono",   short: "Cutive",     stack: '"Cutive Mono","SF Mono",Menlo,monospace', web: "Cutive Mono" },
    { id: "space",      label: "Space Mono",    short: "Space Mono", stack: '"Space Mono","SF Mono",Menlo,monospace', web: "Space Mono" },
    { id: "martian",    label: "Martian Mono",  short: "Martian",    stack: '"Martian Mono","SF Mono",Menlo,monospace', web: "Martian Mono" }
  ];

  var FONT_BY_ID = {};
  FONTS.forEach(function (f) { FONT_BY_ID[f.id] = f; });

  var FONT_KEY = "tc-font";           // localStorage: a font id
  var FONT_SIZE_KEY = "tc-font-size"; // localStorage: px number
  var FONT_SIZE_MIN = 9;
  var FONT_SIZE_MAX = 18;
  var FONT_SIZE_DEFAULT = 13;

  function storedFontId() {
    try {
      var v = window.localStorage.getItem(FONT_KEY);
      return (v && FONT_BY_ID[v]) ? v : "sf-mono";
    } catch (e) { return "sf-mono"; }
  }

  function currentFont() { return FONT_BY_ID[storedFontId()]; }
  function currentFontStack() { return currentFont().stack; }

  function currentFontSize() {
    try {
      var n = parseInt(window.localStorage.getItem(FONT_SIZE_KEY), 10);
      if (!isFinite(n)) return FONT_SIZE_DEFAULT;
      return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n));
    } catch (e) { return FONT_SIZE_DEFAULT; }
  }

  // Apply stack/size to ONE terminal. Setting the same value can be ignored
  // by xterm, and after a web font finishes loading the cell box must be
  // re-measured — so nudge fontFamily through a different value first. That
  // forces xterm to measure with the real face instead of whatever fallback
  // was active when the option was first set.
  function applyFontToTerminal(entry, stack, size) {
    if (!entry || !entry.term) return;
    try {
      entry.term.options.fontFamily = "monospace";
      entry.term.options.fontFamily = stack;
      entry.term.options.fontSize = size;
    } catch (e) {}
  }

  // Push the current font into every live terminal and the --font-mono token
  // (sidebar glyphs etc. follow), then refit — new metrics mean new cols/rows.
  // Hidden terminals (background tabs in single mode) are skipped: measuring a
  // display:none element yields garbage cell sizes. focusSession re-applies
  // the font to a terminal when its tile becomes visible again.
  function applyFontToAll() {
    var stack = currentFontStack();
    var size = currentFontSize();
    document.documentElement.style.setProperty("--font-mono", stack);
    sessions.forEach(function (entry) {
      if (entry.term && entry.el && entry.el.offsetParent !== null) {
        applyFontToTerminal(entry, stack, size);
      }
    });
    scheduleFitAll();
    updateFontButton();
    refreshFontMenu();
  }

  function setFont(id) {
    try {
      if (id && FONT_BY_ID[id]) window.localStorage.setItem(FONT_KEY, id);
    } catch (e) {}
    var f = currentFont();
    // For web faces, apply only once the font has actually loaded. Applying
    // early makes xterm measure the FALLBACK's cells — the terminal keeps
    // drawing with the fallback's metrics and the pick looks like it "didn't
    // take". On load failure (offline) apply anyway; the stack falls back.
    if (f.web && document.fonts && document.fonts.load) {
      document.fonts.load(currentFontSize() + 'px "' + f.web + '"')
        .then(applyFontToAll, applyFontToAll);
    } else {
      applyFontToAll();
    }
  }

  function setFontSize(size) {
    var n = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
    try { window.localStorage.setItem(FONT_SIZE_KEY, String(n)); } catch (e) {}
    applyFontToAll();
  }

  // Kick off the download of the SAVED web font at startup so it is already
  // loaded (or knowingly failed) by the time fonts.ready re-applies fonts —
  // no eager loading of every face, just the one in use.
  function warmSavedFont() {
    var f = currentFont();
    if (f.web && document.fonts && document.fonts.load) {
      try { document.fonts.load(currentFontSize() + 'px "' + f.web + '"'); } catch (e) {}
    }
  }

  var SCROLLBACK = 5000;
  var RESIZE_DEBOUNCE_MS = 80;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // id -> { session, term, fitAddon, el, row, tab }
  var sessions = new Map();

  // Canonical left-to-right / top-to-bottom order of session ids. Drives the
  // tab strip, the sidebar list, and the grid tile order so all three agree.
  var order = [];

  // Id of the tab/row currently being dragged (null when not dragging).
  var dragId = null;

  // Renderer-owned floating preview for reorder gestures. This gives tabs a
  // translucent lifted state instead of Chromium's opaque drag thumbnail.
  var dragAvatar = null;
  var dragAvatarOffsetX = 0;
  var dragAvatarOffsetY = 0;

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
    icon.textContent = session.kind === "preview" ? "◎" : "›_";

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

    // Drag the row vertically to reorder the session.
    attachDrag(li, session.id, "y");

    return li;
  }

  // ---------------------------------------------------------------------------
  // Topbar tab construction (one tab per session; switch + add + reorder).
  // ---------------------------------------------------------------------------

  function buildTab(session) {
    var tab = document.createElement("div");
    tab.className = "term-tab";
    tab.setAttribute("data-id", session.id);
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", "-1");
    tab.setAttribute("aria-selected", "false");
    tab.title = session.title || "";

    var status = document.createElement("span");
    status.className = "session-status"; // reuse the sidebar dot colors + pulse
    status.setAttribute("data-state", session.state || "idle");

    var title = document.createElement("span");
    title.className = "term-tab-title";
    title.textContent = session.title || "";

    var close = document.createElement("button");
    close.className = "term-tab-close";
    close.title = "Close";
    close.setAttribute("aria-label", "Close " + (session.title || "terminal"));
    close.setAttribute("draggable", "false");
    close.textContent = "×";

    tab.appendChild(status);
    tab.appendChild(title);
    tab.appendChild(close);

    // Click the tab → focus the session.
    tab.addEventListener("click", function () {
      focusSession(session.id);
    });

    tab.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        focusSession(session.id);
      }
    });

    // Close button → kill (don't also trigger the tab's focus click).
    close.addEventListener("click", function (ev) {
      ev.stopPropagation();
      killSession(session.id);
    });

    // Drag the tab horizontally to reorder the session.
    attachDrag(tab, session.id, "x");

    return tab;
  }

  // ---------------------------------------------------------------------------
  // Drag-to-reorder. Tabs (axis "x") and sidebar rows (axis "y") share one
  // implementation and one `order` array; on drop we rewrite `order` and
  // re-append every tab/row/tile to match it, so all three views stay in sync.
  // ---------------------------------------------------------------------------

  function clearAllDropMarks() {
    [dom.termTabs, dom.sessionList].forEach(function (host) {
      if (!host) return;
      var marked = host.querySelectorAll(".drop-before, .drop-after");
      for (var i = 0; i < marked.length; i++) {
        marked[i].classList.remove("drop-before", "drop-after");
      }
    });
  }

  function setDropMark(el, after) {
    clearAllDropMarks();
    el.classList.add(after ? "drop-after" : "drop-before");
  }

  // Is the pointer past the midpoint of `el` along the given axis?
  function isAfter(el, e, axis) {
    var rect = el.getBoundingClientRect();
    return axis === "x"
      ? (e.clientX - rect.left) > rect.width / 2
      : (e.clientY - rect.top) > rect.height / 2;
  }

  function removeDragAvatar() {
    if (dragAvatar && dragAvatar.parentNode) {
      dragAvatar.parentNode.removeChild(dragAvatar);
    }
    dragAvatar = null;
  }

  function updateDragAvatar(e) {
    if (!dragAvatar || !e || (!e.clientX && !e.clientY)) return;
    dragAvatar.style.left = (e.clientX - dragAvatarOffsetX) + "px";
    dragAvatar.style.top = (e.clientY - dragAvatarOffsetY) + "px";
  }

  function createDragAvatar(el, e, axis) {
    removeDragAvatar();
    var rect = el.getBoundingClientRect();
    var avatar = el.cloneNode(true);
    avatar.classList.remove("is-dragging", "drop-before", "drop-after", "is-active");
    avatar.classList.add("drag-avatar", axis === "x" ? "is-tab-avatar" : "is-row-avatar");
    avatar.removeAttribute("draggable");
    avatar.style.width = rect.width + "px";
    avatar.style.height = rect.height + "px";
    dragAvatarOffsetX = Math.max(12, Math.min(rect.width - 12, e.clientX - rect.left));
    dragAvatarOffsetY = Math.max(8, Math.min(rect.height - 8, e.clientY - rect.top));
    document.body.appendChild(avatar);
    dragAvatar = avatar;
    updateDragAvatar(e);
  }

  function attachDrag(el, id, axis) {
    el.setAttribute("draggable", "true");

    el.addEventListener("dragstart", function (e) {
      if (e.target && e.target.closest && e.target.closest("button")) {
        e.preventDefault();
        return;
      }
      dragId = id;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", id); } catch (_) {}
        try {
          var blank = document.createElement("canvas");
          blank.width = 1;
          blank.height = 1;
          e.dataTransfer.setDragImage(blank, 0, 0);
        } catch (_) {}
      }
      createDragAvatar(el, e, axis);
      el.classList.add("is-dragging");
      document.documentElement.classList.add("is-reordering");
    });

    el.addEventListener("drag", updateDragAvatar);

    el.addEventListener("dragend", function () {
      dragId = null;
      el.classList.remove("is-dragging");
      document.documentElement.classList.remove("is-reordering");
      removeDragAvatar();
      clearAllDropMarks();
    });

    el.addEventListener("dragover", function (e) {
      if (dragId == null || dragId === id) return;
      e.preventDefault(); // allow the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      setDropMark(el, isAfter(el, e, axis));
    });

    el.addEventListener("dragleave", function () {
      el.classList.remove("drop-before", "drop-after");
    });

    el.addEventListener("drop", function (e) {
      if (dragId == null || dragId === id) { clearAllDropMarks(); return; }
      e.preventDefault();
      var moved = dragId;
      var after = isAfter(el, e, axis);
      clearAllDropMarks();
      reorderSession(moved, id, after);
    });
  }

  // Allow dropping onto the empty area of a strip/list to move the item to the
  // end. Child tabs/rows handle their own drops; we only act when the drop
  // landed on the container itself.
  function enableContainerDrop(host) {
    if (!host) return;
    host.addEventListener("dragover", function (e) {
      if (dragId == null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    });
    host.addEventListener("drop", function (e) {
      if (dragId == null || e.target !== host) return;
      e.preventDefault();
      var moved = dragId;
      clearAllDropMarks();
      var from = order.indexOf(moved);
      if (from === -1) return;
      order.splice(from, 1);
      order.push(moved);
      syncOrderDom();
      if (isGrid()) scheduleFitAll();
    });
  }

  // Move `movedId` to just before/after `targetId` in the canonical order.
  function reorderSession(movedId, targetId, after) {
    var from = order.indexOf(movedId);
    if (from === -1) return;
    order.splice(from, 1);
    var to = order.indexOf(targetId);
    if (to === -1) order.push(movedId);
    else order.splice(after ? to + 1 : to, 0, movedId);
    syncOrderDom();
    if (isGrid()) scheduleFitAll();
  }

  // Re-append every tab/row/tile in `order`. appendChild on an attached node
  // moves it (keeping xterm alive), so iterating in order re-sorts each view.
  function syncOrderDom() {
    order.forEach(function (id) {
      var entry = sessions.get(id);
      if (!entry) return;
      if (entry.tab && dom.termTabs) dom.termTabs.appendChild(entry.tab);
      if (entry.row && dom.sessionList) dom.sessionList.appendChild(entry.row);
      if (entry.el && dom.terminals) dom.terminals.appendChild(entry.el);
    });
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
      allowTransparency: true,
      fontFamily: currentFontStack(),
      fontSize: currentFontSize(),
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

    // 5. Sidebar row + topbar tab.
    var row = buildRow(session);
    dom.sessionList.appendChild(row);

    var tab = buildTab(session);
    if (dom.termTabs) dom.termTabs.appendChild(tab);

    // New session goes at the end of the canonical order.
    order.push(session.id);

    // 6. Store everything.
    var entry = {
      kind: "terminal",
      session: session,
      term: term,
      fitAddon: fitAddon,
      el: div,
      body: body,
      row: row,
      tab: tab,
      headerTitle: headerTitle,
      resizeObserver: null,
      fitRaf: 0
    };
    sessions.set(session.id, entry);

    // 7. Refit whenever the body's box ACTUALLY changes size. A one-shot fit on
    // mount/focus/resize can lock in a row count for a box that hasn't reached
    // its final height yet (initial layout settle, scrollbar reservation, tile
    // becoming visible after display:none, grid reflow) — the extra rows then
    // render past #terminals' overflow:hidden edge and the bottom line gets
    // clipped, with nothing left to re-fit it. The observer closes that gap.
    // We watch the BODY (whose *children* xterm resizes), so fit() never feeds
    // back into the observer.
    if (typeof window.ResizeObserver === "function") {
      entry.resizeObserver = new window.ResizeObserver(function () {
        if (entry.fitRaf) return; // coalesce bursts into one fit per frame
        entry.fitRaf = window.requestAnimationFrame(function () {
          entry.fitRaf = 0;
          safeFit(entry);
        });
      });
      entry.resizeObserver.observe(body);
    }

    // 8. Bookkeeping. A new tile reflows the grid → refit all tiles.
    updateSessionCount();
    if (isGrid()) scheduleFitAll();
  }

  // ---------------------------------------------------------------------------
  // Web preview: an isolated <webview> that participates in the same tab,
  // sidebar, focus, close, grid, and drag ordering model as terminals.
  // ---------------------------------------------------------------------------

  function previewId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return "preview-" + window.crypto.randomUUID();
    }
    return "preview-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function normalizePreviewUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      raw = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i.test(raw)
        ? "http://" + raw
        : "https://" + raw;
    }
    try {
      var parsed = new URL(raw);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : null;
    } catch (e) {
      return null;
    }
  }

  function mountPreview(session) {
    var div = document.createElement("div");
    div.className = "term-instance preview-instance";
    div.setAttribute("data-id", session.id);

    var header = document.createElement("div");
    header.className = "term-header";
    var headerTitle = document.createElement("span");
    headerTitle.className = "term-header-title";
    headerTitle.textContent = session.title;
    var headerClose = document.createElement("button");
    headerClose.className = "term-header-close";
    headerClose.title = "Close";
    headerClose.textContent = "×";
    header.appendChild(headerTitle);
    header.appendChild(headerClose);

    var surface = document.createElement("div");
    surface.className = "preview-surface";

    var toolbar = document.createElement("div");
    toolbar.className = "preview-toolbar";

    function navButton(className, label, glyph) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "preview-nav-button " + className;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.textContent = glyph;
      return button;
    }

    var back = navButton("preview-back", "Back", "‹");
    var forward = navButton("preview-forward", "Forward", "›");
    var reload = navButton("preview-reload", "Reload", "↻");
    back.disabled = true;
    forward.disabled = true;

    var addressForm = document.createElement("form");
    addressForm.className = "preview-address-form";
    var securityMark = document.createElement("span");
    securityMark.className = "preview-security-mark";
    securityMark.textContent = "⌁";
    securityMark.setAttribute("aria-hidden", "true");
    var address = document.createElement("input");
    address.className = "preview-address";
    address.type = "text";
    address.inputMode = "url";
    address.autocomplete = "off";
    address.spellcheck = false;
    address.placeholder = "localhost:3000 or https://example.com";
    address.setAttribute("aria-label", "Preview address");
    addressForm.appendChild(securityMark);
    addressForm.appendChild(address);

    toolbar.appendChild(back);
    toolbar.appendChild(forward);
    toolbar.appendChild(reload);
    toolbar.appendChild(addressForm);

    var webview = document.createElement("webview");
    webview.className = "preview-webview";
    webview.setAttribute("partition", "persist:terminal-container-preview");
    webview.setAttribute("webpreferences", "contextIsolation=yes, nodeIntegration=no, sandbox=yes");
    var homeUrl = new URL("preview-start.html", window.location.href).href;
    webview.setAttribute("src", homeUrl);

    surface.appendChild(toolbar);
    surface.appendChild(webview);
    div.appendChild(header);
    div.appendChild(surface);
    dom.terminals.appendChild(div);

    var row = buildRow(session);
    dom.sessionList.appendChild(row);
    var tab = buildTab(session);
    if (dom.termTabs) dom.termTabs.appendChild(tab);
    order.push(session.id);

    var entry = {
      kind: "preview",
      session: session,
      term: null,
      fitAddon: null,
      el: div,
      row: row,
      tab: tab,
      headerTitle: headerTitle,
      webview: webview,
      address: address,
      backButton: back,
      forwardButton: forward
    };
    sessions.set(session.id, entry);

    function setPreviewTitle(title) {
      var clean = String(title || "").trim() || "Web Preview";
      // Some pages briefly report the raw navigation URL as their title. Keep
      // the glass tab compact until the real document title arrives.
      if (/^https?:\/\//i.test(clean)) {
        try { clean = new URL(clean).hostname.replace(/^www\./, "") || "Web Preview"; } catch (e) {}
      }
      if (clean.length > 54) clean = clean.slice(0, 51) + "…";
      session.title = clean;
      headerTitle.textContent = clean;
      var rowTitle = row.querySelector(".session-title");
      if (rowTitle) rowTitle.textContent = clean;
      var tabTitle = tab.querySelector(".term-tab-title");
      if (tabTitle) tabTitle.textContent = clean;
      var tabClose = tab.querySelector(".term-tab-close");
      if (tabClose) tabClose.setAttribute("aria-label", "Close " + clean);
      tab.title = clean;
      if (activeId === session.id && dom.activeTitle) dom.activeTitle.textContent = clean;
    }

    function syncPreviewUrl(url) {
      var isHome = !url || url === homeUrl;
      address.value = isHome ? "" : url;
      address.classList.remove("is-invalid");
      session.cwd = isHome ? "Web preview" : url;
      var subtitle = row.querySelector(".session-subtitle");
      if (subtitle) subtitle.textContent = session.cwd;
      try {
        back.disabled = !webview.canGoBack();
        forward.disabled = !webview.canGoForward();
      } catch (e) {
        back.disabled = true;
        forward.disabled = true;
      }
    }

    function navigate(value) {
      var url = normalizePreviewUrl(value);
      if (!url) {
        address.classList.add("is-invalid");
        address.focus();
        return;
      }
      address.classList.remove("is-invalid");
      webview.loadURL(url).catch(function () {
        address.classList.add("is-invalid");
      });
    }

    addressForm.addEventListener("submit", function (event) {
      event.preventDefault();
      navigate(address.value);
    });
    address.addEventListener("input", function () { address.classList.remove("is-invalid"); });
    back.addEventListener("click", function () { try { if (webview.canGoBack()) webview.goBack(); } catch (e) {} });
    forward.addEventListener("click", function () { try { if (webview.canGoForward()) webview.goForward(); } catch (e) {} });

    webview.addEventListener("did-start-loading", function () {
      reload.classList.add("is-loading");
      reload.textContent = "×";
      reload.title = "Stop";
      reload.setAttribute("aria-label", "Stop loading");
    });
    webview.addEventListener("dom-ready", function () {
      if (activeId === session.id && !address.value) {
        window.requestAnimationFrame(function () {
          address.focus();
          address.select();
        });
      }
    });
    webview.addEventListener("did-stop-loading", function () {
      reload.classList.remove("is-loading");
      reload.textContent = "↻";
      reload.title = "Reload";
      reload.setAttribute("aria-label", "Reload");
      syncPreviewUrl(webview.getURL());
      try { setPreviewTitle(webview.getTitle()); } catch (e) {}
    });
    reload.addEventListener("click", function () {
      try {
        if (webview.isLoading()) webview.stop();
        else webview.reload();
      } catch (e) {}
    });
    webview.addEventListener("did-navigate", function (event) { syncPreviewUrl(event.url); });
    webview.addEventListener("did-navigate-in-page", function (event) { syncPreviewUrl(event.url); });
    webview.addEventListener("page-title-updated", function (event) { setPreviewTitle(event.title); });
    webview.addEventListener("did-fail-load", function (event) {
      if (event.errorCode !== -3) address.classList.add("is-invalid");
    });

    div.addEventListener("mousedown", function () { focusSession(session.id); });
    headerClose.addEventListener("click", function (event) {
      event.stopPropagation();
      killSession(session.id);
    });

    updateSessionCount();
    if (isGrid()) scheduleFitAll();
  }

  function newPreview() {
    var session = {
      id: previewId(),
      kind: "preview",
      title: "Web Preview",
      cwd: "Web preview",
      state: "preview",
      createdAt: Date.now()
    };
    mountPreview(session);
    focusSession(session.id);
    var entry = sessions.get(session.id);
    if (entry && entry.address) entry.address.focus();
    return session;
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

    // Toggle is-active on all rows, tabs, and term divs.
    sessions.forEach(function (entry, sid) {
      var active = sid === id;
      if (entry.el) entry.el.classList.toggle("is-active", active);
      if (entry.row) entry.row.classList.toggle("is-active", active);
      if (entry.tab) {
        entry.tab.classList.toggle("is-active", active);
        entry.tab.setAttribute("aria-selected", active ? "true" : "false");
        entry.tab.setAttribute("tabindex", active ? "0" : "-1");
      }
    });

    var entry = sessions.get(id);

    // Make sure the active tab is visible if the strip has scrolled.
    if (entry.tab && entry.tab.scrollIntoView) {
      try { entry.tab.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
    }

    // Update the topbar title.
    if (dom.activeTitle) {
      dom.activeTitle.textContent = entry.session.title || "";
    }

    // Hint main which session is focused.
    window.termAPI.focus(id);

    // Re-apply the terminal font before fitting: this tile may have been
    // hidden (display:none) when the font last changed, and hidden terminals
    // can't be measured — this is where they catch up.
    if (entry.term) applyFontToTerminal(entry, currentFontStack(), currentFontSize());

    // Fit + focus the active terminal.
    safeFit(entry);
    if (entry.term) entry.term.focus();
    else if (entry.webview) entry.webview.focus();

    // There is an active terminal now → hide empty-state.
    updateEmptyState();
    if (dom.emptyState) dom.emptyState.style.display = "none";
  }

  // ---------------------------------------------------------------------------
  // killSession: kill in main, tear down locally.
  // ---------------------------------------------------------------------------

  function killSession(id) {
    if (!sessions.has(id)) return;

    var currentEntry = sessions.get(id);
    var teardown = currentEntry && currentEntry.kind === "preview"
      ? Promise.resolve({ ok: true })
      : window.termAPI.kill(id);

    return teardown
      .catch(function (err) {
        console.error("Failed to kill session:", err);
      })
      .then(function () {
        var entry = sessions.get(id);
        if (!entry) return;

        // Stop observing before teardown so the observer can't fire on a
        // detached node, and cancel any pending refit frame.
        try { if (entry.resizeObserver) entry.resizeObserver.disconnect(); } catch (e) {}
        if (entry.fitRaf) { window.cancelAnimationFrame(entry.fitRaf); entry.fitRaf = 0; }

        // Dispose xterm and detach DOM.
        try { if (entry.term) entry.term.dispose(); } catch (e) {}
        if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
        if (entry.row && entry.row.parentNode) entry.row.parentNode.removeChild(entry.row);
        if (entry.tab && entry.tab.parentNode) entry.tab.parentNode.removeChild(entry.tab);

        sessions.delete(id);
        var oi = order.indexOf(id);
        if (oi !== -1) order.splice(oi, 1);

        // If the killed session was active, pick another or go empty.
        if (activeId === id) {
          activeId = null;
          var nextId = order.length ? order[0] : null;
          if (nextId) {
            focusSession(nextId);
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
      var tabStatus = entry.tab && entry.tab.querySelector(".session-status");
      if (tabStatus) tabStatus.setAttribute("data-state", "exited");
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
      var tabStatus = entry.tab && entry.tab.querySelector(".session-status");
      if (tabStatus) tabStatus.setAttribute("data-state", payload.state);
    });

    // title updates → update session, row title, and topbar if active.
    window.termAPI.onTitle(function (payload) {
      var entry = sessions.get(payload.id);
      if (!entry) return;
      if (entry.session) entry.session.title = payload.title;
      var titleEl = entry.row && entry.row.querySelector(".session-title");
      if (titleEl) titleEl.textContent = payload.title;
      if (entry.headerTitle) entry.headerTitle.textContent = payload.title;
      var tabTitleEl = entry.tab && entry.tab.querySelector(".term-tab-title");
      if (tabTitleEl) tabTitleEl.textContent = payload.title;
      if (entry.tab) entry.tab.title = payload.title;
      var tabCloseEl = entry.tab && entry.tab.querySelector(".term-tab-close");
      if (tabCloseEl) tabCloseEl.setAttribute("aria-label", "Close " + payload.title);
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

  // A restrained pointer-following highlight makes the glass respond to the
  // room around it without animating layout or stealing pointer events.
  function enableDynamicGlass() {
    var nextX = window.innerWidth * 0.66;
    var nextY = 70;
    var raf = 0;
    function paint() {
      raf = 0;
      document.documentElement.style.setProperty("--glass-x", nextX + "px");
      document.documentElement.style.setProperty("--glass-y", nextY + "px");
    }
    window.addEventListener("pointermove", function (e) {
      nextX = e.clientX;
      nextY = e.clientY;
      if (!raf) raf = window.requestAnimationFrame(paint);
    }, { passive: true });
    paint();
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  function init() {
    // Resolve DOM handles.
    dom.sessionList = document.getElementById("session-list");
    dom.terminals = document.getElementById("terminals");
    dom.emptyState = document.getElementById("empty-state");
    dom.termTabs = document.getElementById("term-tabs");
    dom.newTabBtn = document.getElementById("new-tab-btn");
    dom.newPreviewBtn = document.getElementById("new-preview-btn");
    dom.activeTitle = document.getElementById("active-title");
    dom.sessionCount = document.getElementById("session-count");
    dom.sessionFilter = document.getElementById("session-filter");
    dom.newSessionBtn = document.getElementById("new-session-btn");
    dom.killActiveBtn = document.getElementById("kill-active");
    dom.themeToggle = document.getElementById("theme-toggle");
    dom.fontToggle = document.getElementById("font-toggle");
    dom.sidebarFooter = document.querySelector(".sidebar-footer");
    dom.layoutToggle = document.getElementById("layout-toggle");

    // Apply the saved/system theme, font, and layout before any terminals exist.
    applyThemeToDom();
    applyFontToAll();
    applyLayout();
    warmSavedFont();
    enableDynamicGlass();

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
    if (dom.newTabBtn) {
      dom.newTabBtn.addEventListener("click", function () { newSession(); });
    }
    if (dom.newPreviewBtn) {
      dom.newPreviewBtn.addEventListener("click", function () { newPreview(); });
    }

    // Dropping on the empty area of either list moves the dragged item to the end.
    enableContainerDrop(dom.termTabs);
    enableContainerDrop(dom.sessionList);
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
    if (dom.fontToggle) {
      dom.fontToggle.addEventListener("click", toggleFontMenu);
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
    window.addEventListener("keydown", function (event) {
      // ⌘T / ⌘N — open a new cozy terminal.
      if ((event.metaKey || event.ctrlKey) && (event.key === "t" || event.key === "n")) {
        event.preventDefault();
        newSession();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l" && activeId) {
        var active = sessions.get(activeId);
        if (active && active.kind === "preview" && active.address) {
          event.preventDefault();
          active.address.focus();
          active.address.select();
        }
      }
    });

    // The monospace font can finish loading AFTER the first fit, changing the
    // cell height while the body's box stays the same — the ResizeObserver
    // can't see that, so the row count would be off (bottom row clipped) until
    // the next resize. Re-fit once fonts are ready to settle it.
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
      document.fonts.ready.then(function () {
        // Web faces finish loading after the first fit; re-apply (which
        // forces a re-measure with the real metrics) and settle the layout.
        applyFontToAll();
        fitAll();
      });
    }

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
