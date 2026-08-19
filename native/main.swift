// main.swift — Terminal Container native host (AppKit + WKWebView).
//
// Replaces the Chromium shell: one window with real under-window vibrancy
// beneath a transparent WKWebView that runs the existing renderer
// (renderer/index.html + xterm.js). The renderer talks to this host via
// renderer/native-bridge.js and the "term" message handler (see Bridge.swift).

import AppKit
import WebKit

// ---------------------------------------------------------------------------
// App delegate — window styling, traffic lights, lifecycle.
// ---------------------------------------------------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow?
    var host: HostViewController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let host = HostViewController()
        self.host = host

        let window = NSWindow(contentViewController: host)
        self.window = window
        window.delegate = self
        window.setContentSize(NSSize(width: 1200, height: 780))
        window.minSize = NSSize(width: 820, height: 560)
        window.styleMask.insert(.fullSizeContentView)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.center()
        window.makeKeyAndOrderFront(nil)

        // Match the HTML layout: cards float 10px in, lights at (24, 22)
        // measured from the window's top-left.
        DispatchQueue.main.async { self.repositionTrafficLights() }

        NSApp.activate(ignoringOtherApps: true)
        log("native host launched")
    }

    private func repositionTrafficLights() {
        guard let window = window else { return }
        let buttons = [
            window.standardWindowButton(.closeButton),
            window.standardWindowButton(.miniaturizeButton),
            window.standardWindowButton(.zoomButton)
        ].compactMap { $0 }
        guard let first = buttons.first else { return }
        let spacing = buttons.count > 1 ? buttons[1].frame.minX - first.frame.minX : 20
        for (index, button) in buttons.enumerated() {
            var frame = button.frame
            frame.origin.x = 24 + CGFloat(index) * spacing
            frame.origin.y = 22
            button.frame = frame
        }
    }

    // AppKit resets the standard buttons to default positions on layout
    // passes — keep pinning them where the HTML expects (24, 22).
    func windowDidResize(_ notification: Notification) {
        DispatchQueue.main.async { self.repositionTrafficLights() }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        DispatchQueue.main.async { self.repositionTrafficLights() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        host?.bridge.store.killAll()
        return .terminateNow
    }
}

// ---------------------------------------------------------------------------
// Host view controller — vibrancy layer + transparent web view + drag strip.
// ---------------------------------------------------------------------------

final class HostViewController: NSViewController, WKNavigationDelegate {
    let bridge = Bridge()
    var webView: WKWebView!

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 1200, height: 780))

        // Real system frosted-wallpaper material behind the CSS glass —
        // the same thing Electron's vibrancy: 'under-window' provided.
        let vibrancy = NSVisualEffectView(frame: view.bounds)
        vibrancy.autoresizingMask = [.width, .height]
        vibrancy.material = .underWindowBackground
        vibrancy.blendingMode = .behindWindow
        vibrancy.state = .active
        view.addSubview(vibrancy)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(bridge, name: "term")
        let webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = .clear
        webView.setValue(false, forKey: "drawsBackground")
        view.addSubview(webView)
        self.webView = webView
        bridge.attach(to: webView)

        // The HTML drag regions (-webkit-app-region) are Chromium-only; a
        // 16px transparent strip above the cards' 10px margin restores
        // window dragging without covering any control.
        let strip = DragStripView(frame: NSRect(x: 0, y: view.bounds.height - 16, width: view.bounds.width, height: 16))
        strip.autoresizingMask = [.width, .minYMargin]
        view.addSubview(strip)

        loadRenderer()
    }

    private func loadRenderer() {
        let root = projectRootURL()
        let index = root.appendingPathComponent("renderer/index.html")
        log("loading renderer from \(index.path)")
        webView.loadFileURL(index, allowingReadAccessTo: root)
    }

    private func projectRootURL() -> URL {
        let path = Bundle.main.bundlePath
        if path.hasSuffix(".app") {
            // .../<project>/build/TerminalContainer.app -> <project>
            return URL(fileURLWithPath: path).deletingLastPathComponent().deletingLastPathComponent()
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("renderer loaded")
    }
}

/// Transparent strip that only exists so mousedown-drag moves the window
/// (the system handles it because mouseDownCanMoveWindow is true).
final class DragStripView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

func log(_ message: String) {
    fputs(message + "\n", stderr)
}

freopen("/tmp/terminal-container-native.log", "w", stderr)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
