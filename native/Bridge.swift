// Bridge.swift — WKScriptMessageHandler implementing the CONTRACT.md IPC
// surface. The renderer's native-bridge.js posts {kind: "invoke"|"send",
// ref, channel, payload}; replies and events come back through
// window.__nativeReply / window.__nativeEvent.

import Foundation
import WebKit

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    let store = SessionStore()

    func attach(to webView: WKWebView) {
        self.webView = webView
        store.webView = webView
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let kind = body["kind"] as? String else { return }
        switch kind {
        case "invoke":
            let ref = body["ref"] as? String ?? UUID().uuidString
            let channel = body["channel"] as? String ?? ""
            let payload = body["payload"] as? [String: Any] ?? [:]
            let result = handle(channel: channel, payload: payload)
            reply(ref: ref, result: result)
        case "send":
            let channel = body["channel"] as? String ?? ""
            let payload = body["payload"] as? [String: Any] ?? [:]
            handle(channel: channel, payload: payload)
        default:
            break
        }
    }

    @discardableResult
    private func handle(channel: String, payload: [String: Any]) -> Any {
        switch channel {
        case "term:create":
            return store.create(opts: payload)
        case "term:list":
            return store.list()
        case "term:kill":
            return store.kill(id: payload["id"] as? String ?? "")
        case "term:input":
            if let id = payload["id"] as? String, let data = payload["data"] as? String {
                store.input(id: id, data: data)
            }
        case "term:resize":
            if let id = payload["id"] as? String,
               let cols = payload["cols"] as? Int,
               let rows = payload["rows"] as? Int {
                store.resize(id: id, cols: cols, rows: rows)
            }
        case "term:focus":
            break // hint only, same as the Electron host
        default:
            break
        }
        return ["ok": true]
    }

    private func reply(ref: String, result: Any) {
        let js = "window.__nativeReply(\"\(ref)\", \(Bridge.jsValue(result)))"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Serialize a plist-typed object as a JavaScript value literal.
    /// JSON is valid JS except U+2028/U+2029, which are escaped here.
    static func jsValue(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              var text = String(data: data, encoding: .utf8) else { return "null" }
        text = text.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
        text = text.replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return text
    }
}
