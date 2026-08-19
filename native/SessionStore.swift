// SessionStore.swift — owns the live sessions and bridges their events into
// the web view. Terminal output is coalesced per main-loop tick so a burst of
// pty writes becomes one evaluateJavaScript call per session (WKWebView JS
// bridges are fast, but one call per 64KB chunk burst is faster).

import Foundation
import WebKit

final class SessionStore {
    private var sessions: [String: PtySession] = [:]
    private var dataBuffer: [String: String] = [:]
    private var flushScheduled = false
    weak var webView: WKWebView?

    func create(opts: [String: Any]) -> [String: Any] {
        let env = ProcessInfo.processInfo.environment
        let shell = (opts["shell"] as? String) ?? env["SHELL"] ?? "/bin/zsh"
        let cwd = (opts["cwd"] as? String) ?? NSHomeDirectory()
        let cols = (opts["cols"] as? Int) ?? 80
        let rows = (opts["rows"] as? Int) ?? 24
        guard let session = PtySession(shell: shell, cwd: cwd, cols: cols, rows: rows) else {
            return ["error": "spawn failed"]
        }
        let id = session.id
        session.onOutput = { [weak self] text in self?.emitData(id: id, text: text) }
        session.onState = { [weak self] state in self?.emit("term:state", ["id": id, "state": state]) }
        session.onTitle = { [weak self] title in self?.emit("term:title", ["id": id, "title": title]) }
        session.onExit = { [weak self] code in self?.emit("term:exit", ["id": id, "exitCode": Int(code)]) }
        sessions[id] = session
        return session.toDict()
    }

    func list() -> [[String: Any]] {
        return sessions.values.map { $0.toDict() }
    }

    func kill(id: String) -> [String: Any] {
        if let session = sessions.removeValue(forKey: id) {
            session.kill()
        }
        return ["ok": true]
    }

    func input(id: String, data: String) {
        sessions[id]?.write(data)
    }

    func resize(id: String, cols: Int, rows: Int) {
        sessions[id]?.resize(cols: cols, rows: rows)
    }

    func killAll() {
        for session in sessions.values {
            session.kill()
        }
        sessions.removeAll()
    }

    // MARK: - Event delivery

    /// Rare events (state/title/exit) go straight through.
    private func emit(_ channel: String, _ payload: [String: Any]) {
        guard let webView = webView else { return }
        let js = "window.__nativeEvent(\"\(channel)\", \(Bridge.jsValue(payload)))"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Terminal data is merged per session and flushed once per main-loop
    /// tick — merging output chunks is safe for xterm consumption.
    fileprivate func emitData(id: String, text: String) {
        dataBuffer[id, default: ""] += text
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.async { [weak self] in
            self?.flush()
        }
    }

    private func flush() {
        flushScheduled = false
        let buffered = dataBuffer
        dataBuffer = [:]
        guard let webView = webView, !buffered.isEmpty else { return }
        for (id, text) in buffered {
            let js = "window.__nativeEvent(\"term:data\", \(Bridge.jsValue(["id": id, "data": text])))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
