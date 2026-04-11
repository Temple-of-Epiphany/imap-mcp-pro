// StatusMenuController.swift - IMAP MCP Control Status Menu Bar Controller
//
// Author: Colin Bitterfield
// Email: colin.bitterfield@templeofepiphany.com
// Date Created: 2026-04-09
// Date Updated: 2026-04-10
// Version: 1.1.0
//
// NSStatusItem-based menu bar controller. Polls LaunchAgent status every 5 seconds
// and provides controls for the IMAP MCP Pro service.

import AppKit
import Foundation

class StatusMenuController: NSObject {
    private let statusItem: NSStatusItem
    private var statusTimer: Timer?
    private let appVersion = "2.13.1"
    private let launchAgentLabel = "com.templeofepiphany.imap-mcp-pro"
    private let plistPath = NSString(
        string: "~/Library/LaunchAgents/com.templeofepiphany.imap-mcp-pro.plist"
    ).expandingTildeInPath
    private let releasesURL = "https://github.com/Temple-of-Epiphany/imap-mcp-pro/releases"
    private lazy var preferencesController: PreferencesWindowController = {
        let controller = PreferencesWindowController()
        controller.onSettingsChanged = { [weak self] in
            DispatchQueue.main.async { self?.buildMenu() }
        }
        return controller
    }()

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        buildMenu()
        startPolling()
    }

    deinit {
        stopPolling()
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    // MARK: - Menu Construction

    private func buildMenu() {
        let running = isServiceRunning()
        let port = readPortFromPlist()

        // Update status item icon — envelope.fill when running, envelope when stopped
        if let button = statusItem.button {
            let symbolName = running ? "envelope.fill" : "envelope"
            if let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: "IMAP MCP Pro") {
                image.isTemplate = true  // adapts to light/dark mode automatically
                button.image = image
            }
            button.title = ""
        }

        let menu = NSMenu()

        // Title item (disabled)
        let titleItem = NSMenuItem(
            title: "IMAP MCP Pro v\(appVersion)",
            action: nil,
            keyEquivalent: ""
        )
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        menu.addItem(NSMenuItem.separator())

        // Status item (disabled, dynamic)
        let statusLabel = NSMenuItem(
            title: "Status: \(running ? "Running" : "Stopped")",
            action: nil,
            keyEquivalent: ""
        )
        statusLabel.isEnabled = false
        menu.addItem(statusLabel)

        // Port item (disabled, dynamic)
        let portItem = NSMenuItem(
            title: "Port: \(port)",
            action: nil,
            keyEquivalent: ""
        )
        portItem.isEnabled = false
        menu.addItem(portItem)

        menu.addItem(NSMenuItem.separator())

        // Open Web UI
        let webUIItem = NSMenuItem(
            title: "Open Web UI",
            action: #selector(openWebUI),
            keyEquivalent: "o"
        )
        webUIItem.target = self
        menu.addItem(webUIItem)

        // Preferences
        let prefsItem = NSMenuItem(
            title: "Preferences…",
            action: #selector(openPreferences),
            keyEquivalent: ","
        )
        prefsItem.target = self
        menu.addItem(prefsItem)

        // Start / Stop service (toggled based on state)
        if running {
            let stopItem = NSMenuItem(
                title: "Stop Service",
                action: #selector(stopService),
                keyEquivalent: ""
            )
            stopItem.target = self
            menu.addItem(stopItem)
        } else {
            let startItem = NSMenuItem(
                title: "Start Service",
                action: #selector(startService),
                keyEquivalent: ""
            )
            startItem.target = self
            menu.addItem(startItem)
        }

        menu.addItem(NSMenuItem.separator())

        // Check for Updates
        let updatesItem = NSMenuItem(
            title: "Check for Updates",
            action: #selector(checkForUpdates),
            keyEquivalent: ""
        )
        updatesItem.target = self
        menu.addItem(updatesItem)

        // Quit
        let quitItem = NSMenuItem(
            title: "Quit",
            action: #selector(quitApp),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    // MARK: - Polling

    private func startPolling() {
        statusTimer = Timer.scheduledTimer(
            withTimeInterval: 5.0,
            repeats: true
        ) { [weak self] _ in
            DispatchQueue.main.async {
                self?.buildMenu()
            }
        }
    }

    private func stopPolling() {
        statusTimer?.invalidate()
        statusTimer = nil
    }

    // MARK: - Menu Actions

    @objc private func openWebUI() {
        let port = readPortFromPlist()
        if let url = URL(string: "http://localhost:\(port)") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func startService() {
        runLaunchctl(args: ["load", plistPath])
        // Rebuild menu after a short delay to reflect new state
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.buildMenu()
        }
    }

    @objc private func stopService() {
        runLaunchctl(args: ["unload", plistPath])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.buildMenu()
        }
    }

    @objc private func checkForUpdates() {
        if let url = URL(string: releasesURL) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openPreferences() {
        preferencesController.showWindow()
    }

    @objc private func quitApp() {
        NSApplication.shared.terminate(nil)
    }

    // MARK: - Service Status

    /// Check if the LaunchAgent is currently listed in launchctl (i.e., loaded and running).
    func isServiceRunning() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["list"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe() // suppress stderr
        try? process.run()
        process.waitUntilExit()
        let output = String(
            data: pipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        return output.contains(launchAgentLabel)
    }

    // MARK: - Plist Reading

    /// Read the PORT value from the LaunchAgent plist. Defaults to 4500.
    func readPortFromPlist() -> Int {
        guard let plist = NSDictionary(contentsOfFile: plistPath),
              let envVars = plist["EnvironmentVariables"] as? [String: Any],
              let portStr = envVars["PORT"] as? String,
              let port = Int(portStr) else {
            return 4500
        }
        return port
    }

    // MARK: - Process Helpers

    private func runLaunchctl(args: [String]) {
        runCommand("/bin/launchctl", args: args)
    }

    private func runCommand(_ command: String, args: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = args
        process.standardOutput = Pipe() // suppress output
        process.standardError = Pipe()  // suppress errors
        try? process.run()
        process.waitUntilExit()
    }
}
