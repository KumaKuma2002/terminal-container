// PtySession.swift — one shell session: forkpty spawn, incremental UTF-8
// decoding (multi-byte output must never be cut mid-character), OSC 0/2
// title parsing, and the running/idle/exited activity state machine.
// Ported 1:1 from the Electron main.js behaviour in CONTRACT.md.

import Foundation
import Darwin

final class PtySession {
    let id: String
    private(set) var pid: pid_t = -1
    private(set) var masterFd: Int32 = -1
    private(set) var title: String
    let cwd: String
    let shell: String
    private(set) var state: String
    let createdAt: Double

    private let queue: DispatchQueue
    private var readSource: DispatchSourceRead?
    private var pendingTail = Data()
    private var idleItem: DispatchWorkItem?

    var onOutput: ((String) -> Void)?
    var onState: ((String) -> Void)?
    var onTitle: ((String) -> Void)?
    var onExit: ((Int32) -> Void)?

    private static let oscTitleRegex = try! NSRegularExpression(
        pattern: "\\x1b\\]([02]);([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)"
    )

    init?(shell: String, cwd: String, cols: Int, rows: Int) {
        self.id = UUID().uuidString
        self.shell = shell
        self.cwd = cwd
        let shellBase = (shell as NSString).lastPathComponent
        let cwdBase = (cwd as NSString).lastPathComponent
        self.title = "\(shellBase) — \(cwdBase.isEmpty ? cwd : cwdBase)"
        self.state = "running"
        self.createdAt = Date().timeIntervalSince1970 * 1000
        self.queue = DispatchQueue(label: "pty.read.\(self.id)")

        var master: Int32 = -1
        var win = winsize()
        win.ws_col = UInt16(max(1, min(cols, 65535)))
        win.ws_row = UInt16(max(1, min(rows, 65535)))

        let forkedPid = forkpty(&master, nil, nil, &win)
        if forkedPid < 0 { return nil }

        if forkedPid == 0 {
            // Child — become the shell. Only C-ish calls before exec.
            setenv("TERM", "xterm-256color", 1)
            if !cwd.isEmpty { chdir(cwd) }
            var argv: [UnsafeMutablePointer<CChar>?] = [strdup(shell)]
            argv.append(nil)
            execvp(shell, &argv)
            _exit(127)
        }

        self.pid = forkedPid
        self.masterFd = master
        _ = fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK)

        // Reap on a dedicated thread to learn the exit code. The WIF*/WEXIT*
        // macros are function-like C macros unavailable to Swift, so the
        // wait status is decoded by hand (sys/wait.h layout).
        Thread.detachNewThread { [weak self] in
            guard let self = self else { return }
            var status: Int32 = 0
            waitpid(self.pid, &status, 0)
            let signal = status & 0x7F
            let code: Int32
            if signal == 0 { code = (status >> 8) & 0xFF }        // normal exit
            else if signal != 0x7F { code = signal }              // killed by signal
            else { code = 0 }                                     // stopped — shouldn't happen
            DispatchQueue.main.async { self.handleExit(code) }
        }

        startReading()
        armIdle()
    }

    deinit {
        readSource?.cancel()
        idleItem?.cancel()
    }

    // MARK: - Public API (called on main)

    func write(_ string: String) {
        let data = Data(string.utf8)
        queue.async { [weak self] in
            guard let self = self, self.masterFd >= 0 else { return }
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                var sent = 0
                while sent < raw.count {
                    let n = Darwin.write(self.masterFd, base + sent, raw.count - sent)
                    if n > 0 { sent += n }
                    else if errno == EINTR { continue }
                    else { return }
                }
            }
        }
    }

    func resize(cols: Int, rows: Int) {
        guard masterFd >= 0 else { return }
        var win = winsize()
        win.ws_col = UInt16(max(1, min(cols, 65535)))
        win.ws_row = UInt16(max(1, min(rows, 65535)))
        _ = ioctl(masterFd, TIOCSWINSZ, &win)
    }

    func kill() {
        guard pid > 0 else { return }
        Darwin.kill(pid, SIGHUP)
    }

    func toDict() -> [String: Any] {
        return [
            "id": id,
            "title": title,
            "cwd": cwd,
            "shell": shell,
            "state": state,
            "createdAt": createdAt
        ]
    }

    // MARK: - Read pump + decoding

    private func startReading() {
        let source = DispatchSource.makeReadSource(fileDescriptor: masterFd, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            var buffer = [UInt8](repeating: 0, count: 65536)
            while true {
                let n = Darwin.read(self.masterFd, &buffer, buffer.count)
                if n > 0 {
                    self.handleRaw(Data(buffer[0..<n]))
                } else {
                    break // EAGAIN (non-blocking) or EOF; exit is reaped separately
                }
            }
        }
        source.resume()
        readSource = source
    }

    private func handleRaw(_ chunk: Data) {
        let text = decode(chunk)
        guard !text.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.state != "running" {
                self.state = "running"
                self.onState?("running")
            }
            self.armIdle()
            self.onOutput?(text)
            if let t = Self.parseTitle(text), !t.isEmpty, t != self.title {
                self.title = t
                self.onTitle?(t)
            }
        }
    }

    /// Incremental UTF-8: hold back a trailing partial sequence so multi-byte
    /// characters (CJK!) split across pty writes never become U+FFFD.
    private func decode(_ chunk: Data) -> String {
        pendingTail.append(chunk)
        let (complete, remainder) = PtySession.splitCompletePrefix(pendingTail)
        pendingTail = remainder
        return String(decoding: complete, as: UTF8.self)
    }

    private static func splitCompletePrefix(_ data: Data) -> (Data, Data) {
        let bytes = [UInt8](data)
        let count = bytes.count
        var cut = count
        if count > 0 {
            for back in 1...min(3, count) {
                let b = bytes[count - back]
                if b & 0xC0 == 0x80 { continue } // continuation byte
                let length: Int
                if b & 0x80 == 0 { length = 1 }
                else if b & 0xE0 == 0xC0 { length = 2 }
                else if b & 0xF0 == 0xE0 { length = 3 }
                else { length = 4 }
                if back < length { cut = count - back } // partial sequence at the tail
                break
            }
        }
        return (data.prefix(cut), data.suffix(count - cut))
    }

    // MARK: - Activity state machine (running -> idle after 600ms quiet)

    private func armIdle() {
        idleItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, self.state == "running" else { return }
            self.state = "idle"
            self.onState?("idle")
        }
        idleItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: item)
    }

    // MARK: - Exit

    private func handleExit(_ code: Int32) {
        guard masterFd >= 0 else { return } // already torn down
        readSource?.cancel()
        readSource = nil
        close(masterFd)
        masterFd = -1
        idleItem?.cancel()
        if state != "exited" {
            state = "exited"
            onState?("exited")
        }
        onExit?(code)
    }

    // MARK: - OSC title

    private static func parseTitle(_ text: String) -> String? {
        let ns = text as NSString
        let matches = oscTitleRegex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard let last = matches.last else { return nil }
        return ns.substring(with: last.range(at: 2))
    }
}
