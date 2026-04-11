// swift-tools-version: 5.9
// Package.swift - IMAP MCP Control Menu Bar App
//
// Author: Colin Bitterfield
// Email: colin.bitterfield@templeofepiphany.com
// Date Created: 2026-04-09
// Date Updated: 2026-04-09
// Version: 1.0.0

import PackageDescription

let package = Package(
    name: "ImapMCPControl",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "ImapMCPControl",
            path: "Sources/ImapMCPControl"
        )
    ]
)
