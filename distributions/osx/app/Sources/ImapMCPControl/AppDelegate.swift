// AppDelegate.swift - IMAP MCP Control Application Delegate
//
// Author: Colin Bitterfield
// Email: colin@bitterfield.com
// Date Created: 2026-04-09
// Date Updated: 2026-04-09
// Version: 1.0.0
//
// NSApplicationDelegate that owns the StatusMenuController lifetime.

import AppKit

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: StatusMenuController?

    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = StatusMenuController()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller = nil
    }
}
