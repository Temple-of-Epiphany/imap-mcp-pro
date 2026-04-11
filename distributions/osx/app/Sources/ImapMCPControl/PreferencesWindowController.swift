// PreferencesWindowController.swift - IMAP MCP Pro Preferences Panel
//
// Author: Colin Bitterfield
// Email: colin.bitterfield@templeofepiphany.com
// Date Created: 2026-04-10
// Date Updated: 2026-04-10
// Version: 1.1.0
//
// Programmatic NSPanel preferences window.
// Sections: Web UI port, Claude Desktop integration, Service behaviour, Database backup/restore.

import AppKit
import Foundation

class PreferencesWindowController: NSObject, NSWindowDelegate {

    private var window: NSPanel?
    private let plistPath = NSString(
        string: "~/Library/LaunchAgents/com.templeofepiphany.imap-mcp-pro.plist"
    ).expandingTildeInPath
    private let claudeConfigPath = NSString(
        string: "~/Library/Application Support/Claude/claude_desktop_config.json"
    ).expandingTildeInPath
    private let installDir = NSString(
        string: "~/.local/share/imap-mcp-pro"
    ).expandingTildeInPath
    private let launchAgentLabel = "com.templeofepiphany.imap-mcp-pro"
    private let dataDir = NSString(string: "~/.imap-mcp").expandingTildeInPath

    // UI references
    private weak var portField: NSTextField?
    private weak var claudeStatusLabel: NSTextField?
    private weak var claudeButton: NSButton?
    private weak var autoStartCheckbox: NSButton?
    private weak var dbPathLabel: NSTextField?

    // Callback to rebuild the status menu after changes
    var onSettingsChanged: (() -> Void)?

    // MARK: - Show / Hide

    func showWindow() {
        if window == nil { buildWindow() }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshClaudeStatus()
        refreshAutoStart()
    }

    // MARK: - Window Construction

    private func buildWindow() {
        let width: CGFloat  = 440
        let height: CGFloat = 390
        let rect = NSRect(x: 0, y: 0, width: width, height: height)

        let panel = NSPanel(
            contentRect: rect,
            styleMask: [.titled, .closable, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "IMAP MCP Pro — Preferences"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.center()

        let content = panel.contentView!
        var y = height - 24

        // ---- Section: Web UI ----------------------------------------
        y -= 30
        addSectionHeader("Web UI", to: content, y: y, width: width)

        y -= 30
        addLabel("Port:", to: content, x: 20, y: y, width: 80)
        let pf = addTextField(
            value: "\(readPort())",
            to: content, x: 110, y: y, width: 80
        )
        portField = pf

        let applyBtn = NSButton(frame: NSRect(x: 200, y: y - 1, width: 110, height: 24))
        applyBtn.title = "Apply & Restart"
        applyBtn.bezelStyle = .rounded
        applyBtn.target = self
        applyBtn.action = #selector(applyPort)
        content.addSubview(applyBtn)

        let openBtn = NSButton(frame: NSRect(x: 320, y: y - 1, width: 100, height: 24))
        openBtn.title = "Open Web UI"
        openBtn.bezelStyle = .rounded
        openBtn.target = self
        openBtn.action = #selector(openWebUI)
        content.addSubview(openBtn)

        // ---- Section: Service ----------------------------------------
        y -= 46
        addSectionHeader("Service", to: content, y: y, width: width)

        y -= 30
        let cb = NSButton(checkboxWithTitle: "Start automatically at login", target: self, action: #selector(toggleAutoStart))
        cb.frame = NSRect(x: 20, y: y, width: 300, height: 22)
        content.addSubview(cb)
        autoStartCheckbox = cb

        // ---- Section: Claude Desktop ---------------------------------
        y -= 46
        addSectionHeader("Claude Desktop Integration", to: content, y: y, width: width)

        y -= 30
        let csl = NSTextField(labelWithString: "")
        csl.frame = NSRect(x: 20, y: y, width: 260, height: 20)
        csl.font = NSFont.systemFont(ofSize: 12)
        content.addSubview(csl)
        claudeStatusLabel = csl

        let cBtn = NSButton(frame: NSRect(x: 290, y: y - 2, width: 130, height: 24))
        cBtn.bezelStyle = .rounded
        cBtn.target = self
        cBtn.action = #selector(toggleClaudeDesktop)
        content.addSubview(cBtn)
        claudeButton = cBtn

        // ---- Section: Database ---------------------------------------
        y -= 46
        addSectionHeader("Database", to: content, y: y, width: width)

        y -= 28
        let dbLabel = NSTextField(labelWithString: "~/.imap-mcp/data.db")
        dbLabel.frame = NSRect(x: 20, y: y, width: 240, height: 18)
        dbLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        dbLabel.textColor = .secondaryLabelColor
        content.addSubview(dbLabel)
        dbPathLabel = dbLabel

        let backupBtn = NSButton(frame: NSRect(x: 270, y: y - 2, width: 70, height: 24))
        backupBtn.title = "Backup"
        backupBtn.bezelStyle = .rounded
        backupBtn.target = self
        backupBtn.action = #selector(backupDatabase)
        content.addSubview(backupBtn)

        let restoreBtn = NSButton(frame: NSRect(x: 350, y: y - 2, width: 70, height: 24))
        restoreBtn.title = "Restore"
        restoreBtn.bezelStyle = .rounded
        restoreBtn.target = self
        restoreBtn.action = #selector(restoreDatabase)
        content.addSubview(restoreBtn)

        // ---- Divider + Version ---------------------------------------
        y -= 30
        let divider = NSBox(frame: NSRect(x: 20, y: y, width: width - 40, height: 1))
        divider.boxType = .separator
        content.addSubview(divider)

        y -= 28
        let versionLabel = NSTextField(labelWithString: "IMAP MCP Pro v\(appVersion())")
        versionLabel.frame = NSRect(x: 20, y: y, width: 220, height: 18)
        versionLabel.font = NSFont.systemFont(ofSize: 11)
        versionLabel.textColor = .secondaryLabelColor
        content.addSubview(versionLabel)

        let closeBtn = NSButton(frame: NSRect(x: width - 100, y: y - 2, width: 80, height: 24))
        closeBtn.title = "Close"
        closeBtn.bezelStyle = .rounded
        closeBtn.keyEquivalent = "\r"
        closeBtn.target = self
        closeBtn.action = #selector(closeWindow)
        content.addSubview(closeBtn)

        self.window = panel
    }

    // MARK: - UI Helpers

    @discardableResult
    private func addLabel(_ text: String, to view: NSView, x: CGFloat, y: CGFloat, width: CGFloat) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: x, y: y + 3, width: width, height: 20)
        label.font = NSFont.systemFont(ofSize: 13)
        view.addSubview(label)
        return label
    }

    @discardableResult
    private func addTextField(value: String, to view: NSView, x: CGFloat, y: CGFloat, width: CGFloat) -> NSTextField {
        let tf = NSTextField(frame: NSRect(x: x, y: y, width: width, height: 22))
        tf.stringValue = value
        tf.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        view.addSubview(tf)
        return tf
    }

    private func addSectionHeader(_ title: String, to view: NSView, y: CGFloat, width: CGFloat) {
        let label = NSTextField(labelWithString: title.uppercased())
        label.frame = NSRect(x: 20, y: y, width: width - 40, height: 18)
        label.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
        label.textColor = .secondaryLabelColor
        view.addSubview(label)

        let line = NSBox(frame: NSRect(x: 20, y: y - 2, width: width - 40, height: 1))
        line.boxType = .separator
        view.addSubview(line)
    }

    // MARK: - Port

    private func readPort() -> Int {
        guard let plist = NSDictionary(contentsOfFile: plistPath),
              let env = plist["EnvironmentVariables"] as? [String: Any],
              let portStr = env["PORT"] as? String,
              let port = Int(portStr) else { return 4500 }
        return port
    }

    @objc private func applyPort() {
        guard let text = portField?.stringValue,
              let newPort = Int(text),
              newPort >= 1024, newPort <= 65535 else {
            showAlert("Invalid port. Enter a number between 1024 and 65535.")
            return
        }

        // Read plist as mutable dictionary
        guard let plist = NSMutableDictionary(contentsOfFile: plistPath) else {
            showAlert("Could not read LaunchAgent plist.")
            return
        }
        guard let env = plist["EnvironmentVariables"] as? NSMutableDictionary ??
              (plist["EnvironmentVariables"] as? [String: Any]).map({ NSMutableDictionary(dictionary: $0) }) else {
            showAlert("Could not read EnvironmentVariables from plist.")
            return
        }
        env["PORT"] = "\(newPort)"
        plist["EnvironmentVariables"] = env
        plist.write(toFile: plistPath, atomically: true)

        // Restart the service
        runCommand("/bin/launchctl", args: ["unload", plistPath])
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
            self.runCommand("/bin/launchctl", args: ["load", self.plistPath])
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                self.onSettingsChanged?()
            }
        }
    }

    @objc private func openWebUI() {
        let port = readPort()
        if let url = URL(string: "http://localhost:\(port)") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Auto-start

    private func refreshAutoStart() {
        let loaded = isAgentLoaded()
        autoStartCheckbox?.state = loaded ? .on : .off
    }

    private func isAgentLoaded() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["list"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        try? p.run(); p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return out.contains(launchAgentLabel)
    }

    @objc private func toggleAutoStart() {
        guard let cb = autoStartCheckbox else { return }
        if cb.state == .on {
            runCommand("/bin/launchctl", args: ["load", plistPath])
        } else {
            runCommand("/bin/launchctl", args: ["unload", plistPath])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            self.onSettingsChanged?()
        }
    }

    // MARK: - Claude Desktop

    private func refreshClaudeStatus() {
        let (configured, legacy) = claudeConfigState()
        if configured {
            claudeStatusLabel?.stringValue = "Status: Configured ✓"
            claudeStatusLabel?.textColor = .systemGreen
            claudeButton?.title = "Remove from Claude"
        } else if legacy {
            claudeStatusLabel?.stringValue = "Status: Legacy entry (imap)"
            claudeStatusLabel?.textColor = .systemOrange
            claudeButton?.title = "Fix Claude Config"
        } else {
            claudeStatusLabel?.stringValue = "Status: Not configured"
            claudeStatusLabel?.textColor = .secondaryLabelColor
            claudeButton?.title = "Add to Claude"
        }
    }

    /// Returns (isCurrentEntryPresent, isLegacyEntryPresent)
    private func claudeConfigState() -> (Bool, Bool) {
        guard let data = FileManager.default.contents(atPath: claudeConfigPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let servers = json["mcpServers"] as? [String: Any] else {
            return (false, false)
        }
        return (servers["imap-mcp-pro"] != nil, servers["imap"] != nil)
    }

    @objc private func toggleClaudeDesktop() {
        let (configured, _) = claudeConfigState()
        if configured {
            removeFromClaude()
        } else {
            addToClaude()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.refreshClaudeStatus()
        }
    }

    private func addToClaude() {
        let serverJs    = "\(installDir)/dist/index.js"
        let bundledNode = "\(installDir)/runtime/node/bin/node"
        let userId      = NSUserName()

        var config: [String: Any] = [:]
        if let data = FileManager.default.contents(atPath: claudeConfigPath),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            config = json
        }
        var servers = config["mcpServers"] as? [String: Any] ?? [:]
        servers.removeValue(forKey: "imap")           // remove legacy key
        servers["imap-mcp-pro"] = [
            "command": bundledNode,
            "args": [serverJs],
            "env": ["MCP_USER_ID": userId]
        ]
        config["mcpServers"] = servers

        if let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: claudeConfigPath))
            showAlert("Claude Desktop configured.\n\nRestart Claude Desktop to apply changes.", title: "Done")
        }
    }

    private func removeFromClaude() {
        guard let data = FileManager.default.contents(atPath: claudeConfigPath),
              var config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        var servers = config["mcpServers"] as? [String: Any] ?? [:]
        servers.removeValue(forKey: "imap-mcp-pro")
        servers.removeValue(forKey: "imap")
        config["mcpServers"] = servers
        if let out = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]) {
            try? out.write(to: URL(fileURLWithPath: claudeConfigPath))
            showAlert("Removed from Claude Desktop.\n\nRestart Claude Desktop to apply changes.", title: "Done")
        }
    }

    // MARK: - Database Backup / Restore

    @objc private func backupDatabase() {
        let panel = NSSavePanel()
        panel.title = "Save IMAP MCP Pro Backup"
        panel.nameFieldStringValue = "imap-mcp-pro-backup-\(dateStamp()).zip"
        panel.allowedContentTypes = [.zip]
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, let dest = panel.url else { return }

        DispatchQueue.global(qos: .userInitiated).async {
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("imap-mcp-backup-\(UUID().uuidString)")
            let fm = FileManager.default
            do {
                try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
                // Copy all files in ~/.imap-mcp (db + key files)
                let src = URL(fileURLWithPath: self.dataDir)
                for file in (try? fm.contentsOfDirectory(at: src, includingPropertiesForKeys: nil)) ?? [] {
                    try fm.copyItem(at: file, to: tmp.appendingPathComponent(file.lastPathComponent))
                }
                // Zip via ditto (built-in macOS, preserves permissions)
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                p.arguments = ["-c", "-k", "--sequesterRsrc", tmp.path, dest.path]
                try p.run(); p.waitUntilExit()
                try? fm.removeItem(at: tmp)

                DispatchQueue.main.async {
                    self.showAlert("Backup saved to:\n\(dest.path)", title: "Backup Complete")
                }
            } catch {
                DispatchQueue.main.async {
                    self.showAlert("Backup failed:\n\(error.localizedDescription)", title: "Error")
                }
            }
        }
    }

    @objc private func restoreDatabase() {
        // Warn first
        let alert = NSAlert()
        alert.messageText = "Restore Database?"
        alert.informativeText = "This will replace your current database and keys with those from the backup.\n\nThe service will be stopped during restore and restarted afterward.\n\nThis cannot be undone."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Choose Backup…")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let panel = NSOpenPanel()
        panel.title = "Select IMAP MCP Pro Backup"
        panel.allowedContentTypes = [.zip]
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let src = panel.url else { return }

        DispatchQueue.global(qos: .userInitiated).async {
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("imap-mcp-restore-\(UUID().uuidString)")
            let fm = FileManager.default
            do {
                // Stop service
                self.runCommand("/bin/launchctl", args: ["unload", self.plistPath])
                Thread.sleep(forTimeInterval: 1.0)

                // Extract zip
                try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
                let unzip = Process()
                unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                unzip.arguments = ["-x", "-k", src.path, tmp.path]
                try unzip.run(); unzip.waitUntilExit()

                // Replace ~/.imap-mcp contents
                let dest = URL(fileURLWithPath: self.dataDir)
                try? fm.createDirectory(at: dest, withIntermediateDirectories: true)
                for file in (try? fm.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil)) ?? [] {
                    let target = dest.appendingPathComponent(file.lastPathComponent)
                    try? fm.removeItem(at: target)
                    try fm.copyItem(at: file, to: target)
                }
                try? fm.removeItem(at: tmp)

                // Restart service
                self.runCommand("/bin/launchctl", args: ["load", self.plistPath])

                DispatchQueue.main.async {
                    self.showAlert("Restore complete. Service restarted.", title: "Restore Complete")
                }
            } catch {
                // Try to restart service even on error
                self.runCommand("/bin/launchctl", args: ["load", self.plistPath])
                DispatchQueue.main.async {
                    self.showAlert("Restore failed:\n\(error.localizedDescription)", title: "Error")
                }
            }
        }
    }

    private func dateStamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    // MARK: - Helpers

    private func appVersion() -> String {
        if let plist = NSDictionary(contentsOfFile: plistPath),
           let env = plist["EnvironmentVariables"] as? [String: Any],
           let ver = env["IMAP_MCP_VERSION"] as? String { return ver }
        return "—"
    }

    private func showAlert(_ message: String, title: String = "IMAP MCP Pro") {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.alertStyle = .informational
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    private func runCommand(_ command: String, args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: command)
        p.arguments = args
        p.standardOutput = Pipe()
        p.standardError  = Pipe()
        try? p.run()
        p.waitUntilExit()
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        onSettingsChanged?()
    }

    @objc private func closeWindow() {
        window?.close()
    }
}
