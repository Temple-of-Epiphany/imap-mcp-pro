#!/usr/bin/env swift
// generate-icon.swift - Generate AppIcon.icns from SF Symbol envelope.fill
//
// Author: Colin Bitterfield
// Email: colin.bitterfield@templeofepiphany.com
// Date Created: 2026-04-11
// Date Updated: 2026-04-11
// Version: 1.0.0
//
// Renders the SF Symbol "envelope.fill" at all required iconset sizes
// and produces an AppIcon.icns using iconutil.
//
// Usage: swift generate-icon.swift <output-dir>
//   output-dir: directory where AppIcon.icns will be written

import AppKit
import Foundation

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: generate-icon.swift <output-dir>\n", stderr)
    exit(1)
}

let outputDir = URL(fileURLWithPath: CommandLine.arguments[1])
let iconsetDir = outputDir.appendingPathComponent("AppIcon.iconset")
let icnsPath   = outputDir.appendingPathComponent("AppIcon.icns")

let fm = FileManager.default
try? fm.removeItem(at: iconsetDir)
try fm.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

// Required sizes: (filename, points, scale)
let sizes: [(String, CGFloat, CGFloat)] = [
    ("icon_16x16.png",      16,  1),
    ("icon_16x16@2x.png",   16,  2),
    ("icon_32x32.png",      32,  1),
    ("icon_32x32@2x.png",   32,  2),
    ("icon_128x128.png",    128, 1),
    ("icon_128x128@2x.png", 128, 2),
    ("icon_256x256.png",    256, 1),
    ("icon_256x256@2x.png", 256, 2),
    ("icon_512x512.png",    512, 1),
    ("icon_512x512@2x.png", 512, 2),
]

func renderIcon(pointSize: CGFloat, scale: CGFloat) -> NSImage? {
    let pixels = pointSize * scale
    let rect   = NSRect(x: 0, y: 0, width: pixels, height: pixels)

    let image = NSImage(size: rect.size)
    image.lockFocus()

    // Background: rounded rect in a mid-blue
    let bgColor = NSColor(red: 0.18, green: 0.44, blue: 0.84, alpha: 1.0)
    let radius  = pixels * 0.22
    let bgPath  = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    bgColor.setFill()
    bgPath.fill()

    // SF Symbol: envelope.fill in white, centered, ~62% of icon size
    let symbolSize = pixels * 0.62
    let config = NSImage.SymbolConfiguration(pointSize: symbolSize, weight: .regular)
    if let symbol = NSImage(systemSymbolName: "envelope.fill", accessibilityDescription: nil)?
        .withSymbolConfiguration(config) {
        symbol.isTemplate = false
        // Tint white by drawing into a white-filled context
        let tinted = NSImage(size: symbol.size)
        tinted.lockFocus()
        NSColor.white.setFill()
        NSRect(origin: .zero, size: symbol.size).fill(using: .destinationOver)
        symbol.draw(in: NSRect(origin: .zero, size: symbol.size),
                    from: .zero, operation: .destinationIn, fraction: 1.0)
        tinted.unlockFocus()

        let x = (pixels - tinted.size.width)  / 2
        let y = (pixels - tinted.size.height) / 2
        tinted.draw(in: NSRect(x: x, y: y, width: tinted.size.width, height: tinted.size.height))
    }

    image.unlockFocus()
    return image
}

func savePNG(_ image: NSImage, to url: URL) throws {
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "IconGen", code: 1, userInfo: [NSLocalizedDescriptionKey: "PNG conversion failed"])
    }
    try png.write(to: url)
}

// Render and save all sizes
for (filename, points, scale) in sizes {
    guard let img = renderIcon(pointSize: points, scale: scale) else {
        fputs("Failed to render \(filename)\n", stderr)
        exit(1)
    }
    let dest = iconsetDir.appendingPathComponent(filename)
    try savePNG(img, to: dest)
    print("  \(filename) (\(Int(points * scale))px)")
}

// Run iconutil to produce .icns
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", "-o", icnsPath.path, iconsetDir.path]
try iconutil.run()
iconutil.waitUntilExit()

guard iconutil.terminationStatus == 0 else {
    fputs("iconutil failed\n", stderr)
    exit(1)
}

// Clean up iconset
try? fm.removeItem(at: iconsetDir)

print("AppIcon.icns → \(icnsPath.path)")
