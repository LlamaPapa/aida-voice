import Cocoa
import WebKit

// ══════════════════════════════════════════════════════════════
//  AIDA Voice — Standalone macOS app
//  Embeds: server binary, audio helper, global hotkey, HUD
// ══════════════════════════════════════════════════════════════

let PORT = 7890
var serverProcess: Process?
var helperProcess: Process?

// ── HUD state ────────────────────────────────────────────────
var hudWindow: NSWindow?
var hudTimer: Timer?
var hudPollTimer: Timer?
var isRecording = false
var prevBarH: [CGFloat] = []
let levelFilePath = (ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()) + "aida-voice-level"

// ── HUD Design ───────────────────────────────────────────────
let HUD_W: CGFloat = 260
let HUD_H: CGFloat = 52
let NUM_BARS = 24
let BAR_W: CGFloat = 3
let BAR_GAP: CGFloat = 3.5
let BAR_MAX_H: CGFloat = 28
let BAR_MIN_H: CGFloat = 3
let CORNER_R: CGFloat = 26
let BARS_START_X: CGFloat = 40

let BG_COLOR = NSColor(red: 0.08, green: 0.08, blue: 0.12, alpha: 0.94)
let ACCENT_COLOR = NSColor(red: 0.0, green: 1.0, blue: 0.53, alpha: 0.7)
let DOT_RED = NSColor(red: 1.0, green: 0.25, blue: 0.25, alpha: 1)

// Step colors
let STEP_COLORS: [String: NSColor] = [
    "transcribing": NSColor(red: 0.35, green: 0.5, blue: 1.0, alpha: 1),
    "structuring": NSColor(red: 0.6, green: 0.4, blue: 1.0, alpha: 1),
    "copying": NSColor(red: 0.0, green: 0.8, blue: 0.5, alpha: 1),
]
let STEP_LABELS: [String: String] = [
    "transcribing": "Transcribing...",
    "structuring": "Structuring...",
    "copying": "Copying...",
]

// ── HUD View (custom drawing) ────────────────────────────────
class RecordingHUDView: NSView {
    var barHeights: [CGFloat] = Array(repeating: BAR_MIN_H, count: NUM_BARS)
    var dotColor: NSColor = DOT_RED
    var dotAlpha: CGFloat = 1.0

    override func draw(_ dirtyRect: NSRect) {
        // Background pill
        let path = NSBezierPath(roundedRect: bounds, xRadius: CORNER_R, yRadius: CORNER_R)
        BG_COLOR.setFill()
        path.fill()

        // Border
        NSColor(red: 0.2, green: 0.2, blue: 0.25, alpha: 0.5).setStroke()
        let borderRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let borderPath = NSBezierPath(roundedRect: borderRect, xRadius: CORNER_R, yRadius: CORNER_R)
        borderPath.lineWidth = 1
        borderPath.stroke()

        // Recording dot
        let dotCenter = NSPoint(x: 22, y: bounds.height / 2)
        let dotPath = NSBezierPath(ovalIn: NSRect(x: dotCenter.x - 4.5, y: dotCenter.y - 4.5, width: 9, height: 9))
        dotColor.withAlphaComponent(dotAlpha).setFill()
        dotPath.fill()

        // Waveform bars
        for i in 0..<NUM_BARS {
            let h = barHeights[i]
            let x = BARS_START_X + CGFloat(i) * (BAR_W + BAR_GAP)
            let y = (bounds.height - h) / 2
            let alpha = 0.35 + (h / BAR_MAX_H) * 0.65
            let barRect = NSRect(x: x, y: y, width: BAR_W, height: h)
            let barPath = NSBezierPath(roundedRect: barRect, xRadius: 1.5, yRadius: 1.5)
            NSColor(red: 0.0, green: 1.0, blue: 0.53, alpha: alpha).setFill()
            barPath.fill()
        }
    }
}

class ProcessingHUDView: NSView {
    var stepText: String = "Processing..."
    var stepColor: NSColor = NSColor(red: 0.35, green: 0.5, blue: 1.0, alpha: 1)
    var dotAlpha: CGFloat = 1.0

    override func draw(_ dirtyRect: NSRect) {
        // Background pill
        let path = NSBezierPath(roundedRect: bounds, xRadius: CORNER_R, yRadius: CORNER_R)
        BG_COLOR.setFill()
        path.fill()

        // Border
        NSColor(red: 0.2, green: 0.2, blue: 0.25, alpha: 0.5).setStroke()
        let borderPath = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: CORNER_R, yRadius: CORNER_R)
        borderPath.lineWidth = 1
        borderPath.stroke()

        // Dot
        let dotCenter = NSPoint(x: 24, y: bounds.height / 2)
        let dotPath = NSBezierPath(ovalIn: NSRect(x: dotCenter.x - 4.5, y: dotCenter.y - 4.5, width: 9, height: 9))
        stepColor.withAlphaComponent(dotAlpha).setFill()
        dotPath.fill()

        // Text
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: stepColor,
        ]
        let str = NSAttributedString(string: stepText, attributes: attrs)
        let textRect = NSRect(x: 40, y: (bounds.height - 18) / 2, width: 150, height: 20)
        str.draw(in: textRect)
    }
}

// ── App Delegate ─────────────────────────────────────────────
class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var mainWindow: NSWindow?
    var webView: WKWebView?
    var statusItem: NSStatusItem?
    var recordingHUDView: RecordingHUDView?
    var processingHUDView: ProcessingHUDView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)  // Menu bar app, no dock icon

        // Start backend processes
        startHelper()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.startServer()
        }

        // Setup menu bar icon
        setupStatusItem()

        // Setup global hotkey (Option+Space)
        setupGlobalHotkey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        killProcesses()
    }

    // ── Backend processes ─────────────────────────────────────
    func startHelper() {
        let bundle = Bundle.main
        let helperPath = bundle.path(forResource: "AidaVoiceHelper", ofType: nil, inDirectory: "bin")
            ?? bundle.bundlePath + "/Contents/Resources/bin/AidaVoiceHelper"

        guard FileManager.default.fileExists(atPath: helperPath) else {
            NSLog("AIDA Voice: helper not found at \(helperPath)")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: helperPath)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            helperProcess = proc
            NSLog("AIDA Voice: helper started")
        } catch {
            NSLog("AIDA Voice: helper failed: \(error)")
        }
    }

    func startServer() {
        let bundle = Bundle.main
        let serverPath = bundle.path(forResource: "aida-voice-server", ofType: nil, inDirectory: "bin")
            ?? bundle.bundlePath + "/Contents/Resources/bin/aida-voice-server"

        guard FileManager.default.fileExists(atPath: serverPath) else {
            NSLog("AIDA Voice: server not found at \(serverPath)")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: serverPath)
        proc.arguments = ["daemon", "--port", "\(PORT)"]
        // Set working dir to Resources so server finds .env
        let resourcesDir = bundle.bundlePath + "/Contents/Resources"
        proc.currentDirectoryURL = URL(fileURLWithPath: resourcesDir)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            serverProcess = proc
            NSLog("AIDA Voice: server started on port \(PORT)")
        } catch {
            NSLog("AIDA Voice: server failed: \(error)")
        }
    }

    func killProcesses() {
        if let p = serverProcess, p.isRunning { p.terminate() }
        if let p = helperProcess, p.isRunning { p.terminate() }
    }

    // ── Menu bar ──────────────────────────────────────────────
    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "AIDA Voice")
            button.image?.size = NSSize(width: 16, height: 16)
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open AIDA Voice", action: #selector(openWindow), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Hotkey: Option+Space", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem?.menu = menu
    }

    @objc func openWindow() {
        if mainWindow == nil {
            createMainWindow()
        }
        mainWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func createMainWindow() {
        let webConfig = WKWebViewConfiguration()
        webConfig.mediaTypesRequiringUserActionForPlayback = []
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        webConfig.defaultWebpagePreferences = prefs

        let wv = WKWebView(frame: .zero, configuration: webConfig)
        wv.uiDelegate = self
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground")
        webView = wv

        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 420, height: 700)
        let ww: CGFloat = 420, wh: CGFloat = 700
        let wx = screenFrame.maxX - ww - 20
        let wy = screenFrame.maxY - wh - 20

        let win = NSWindow(
            contentRect: NSRect(x: wx, y: wy, width: ww, height: wh),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        win.title = "AIDA Voice"
        win.contentView = wv
        win.minSize = NSSize(width: 340, height: 500)
        win.isReleasedWhenClosed = false
        win.backgroundColor = NSColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1)
        win.titlebarAppearsTransparent = true
        win.appearance = NSAppearance(named: .darkAqua)
        mainWindow = win

        waitForDaemon {
            wv.load(URLRequest(url: URL(string: "http://localhost:\(PORT)")!))
            win.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // ── Mic permission for WKWebView ──────────────────────────
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "localhost" ? .grant : .prompt)
    }

    // ── Wait for daemon ───────────────────────────────────────
    func waitForDaemon(completion: @escaping () -> Void) {
        let url = URL(string: "http://localhost:\(PORT)/api/health")!
        var attempts = 0
        func check() {
            attempts += 1
            URLSession.shared.dataTask(with: url) { _, response, _ in
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    DispatchQueue.main.async { completion() }
                } else if attempts < 40 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { check() }
                } else {
                    DispatchQueue.main.async { completion() }
                }
            }.resume()
        }
        check()
    }

    // ── Global Hotkey (Option+Space via CGEvent tap) ──────────
    func setupGlobalHotkey() {
        let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                if type == .keyDown {
                    let keycode = event.getIntegerValueField(.keyboardEventKeycode)
                    let flags = event.flags
                    // Space = keycode 49, Option = .maskAlternate
                    if keycode == 49 && flags.contains(.maskAlternate) &&
                       !flags.contains(.maskCommand) && !flags.contains(.maskControl) {
                        DispatchQueue.main.async { toggleRecording() }
                        return nil  // consume the event
                    }
                }
                return Unmanaged.passRetained(event)
            },
            userInfo: nil
        ) else {
            NSLog("AIDA Voice: cannot create CGEvent tap — grant Accessibility permission in System Settings")
            // Show alert
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "Accessibility Permission Required"
                alert.informativeText = "AIDA Voice needs Accessibility access to capture the Option+Space hotkey.\n\nGo to System Settings → Privacy & Security → Accessibility and enable AIDA Voice."
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Open System Settings")
                alert.addButton(withTitle: "Later")
                if alert.runModal() == .alertFirstButtonReturn {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                }
            }
            return
        }

        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        NSLog("AIDA Voice: global hotkey (Option+Space) registered")
    }
}

// ── Toggle recording ─────────────────────────────────────────
func toggleRecording() {
    let url = URL(string: "http://localhost:\(PORT)/api/toggle")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"

    URLSession.shared.dataTask(with: request) { data, response, error in
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = json["status"] as? String else {
            DispatchQueue.main.async {
                // Daemon not running
                let alert = NSAlert()
                alert.messageText = "Voice daemon not running"
                alert.informativeText = "The server hasn't started yet. Please wait a moment."
                alert.runModal()
            }
            return
        }

        DispatchQueue.main.async {
            if status == "recording" {
                isRecording = true
                showRecordingHUD()
                // Play start sound
                NSSound(named: "Pop")?.play()
            } else if status == "stopped" {
                isRecording = false
                showProcessingHUD()
                // Play stop sound
                NSSound(named: "Purr")?.play()
            }
        }
    }.resume()
}

// ── Recording HUD ────────────────────────────────────────────
func showRecordingHUD() {
    destroyHUD()

    guard let screen = NSScreen.main?.frame else { return }
    let x = screen.midX - HUD_W / 2
    let y = screen.maxY - 80

    let win = NSWindow(
        contentRect: NSRect(x: x, y: y, width: HUD_W, height: HUD_H),
        styleMask: [.borderless], backing: .buffered, defer: false
    )
    win.isOpaque = false
    win.backgroundColor = .clear
    win.level = .floating
    win.collectionBehavior = [.canJoinAllSpaces, .stationary]
    win.ignoresMouseEvents = true

    let view = RecordingHUDView(frame: NSRect(x: 0, y: 0, width: HUD_W, height: HUD_H))
    prevBarH = Array(repeating: BAR_MIN_H, count: NUM_BARS)
    win.contentView = view

    win.alphaValue = 0
    win.orderFront(nil)

    // Fade in
    NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.15
        win.animator().alphaValue = 1
    }

    hudWindow = win

    // Animate bars from real mic level
    hudTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
        guard let view = hudWindow?.contentView as? RecordingHUDView else { return }

        // Read level file
        var level: CGFloat = 0
        if let str = try? String(contentsOfFile: levelFilePath, encoding: .utf8),
           let val = Double(str.trimmingCharacters(in: .whitespacesAndNewlines)) {
            level = CGFloat(val)
        }

        let t = CACurrentMediaTime()
        for i in 0..<NUM_BARS {
            let wave1 = sin(t * 9.5 + Double(i) * 0.7) * 0.25
            let wave2 = sin(t * 14.2 + Double(i) * 1.3) * 0.15
            let variation = CGFloat(max(0.2, min(1.0, 0.6 + wave1 + wave2)))
            var targetH = BAR_MIN_H + level * (BAR_MAX_H - BAR_MIN_H) * variation
            targetH = max(BAR_MIN_H, min(BAR_MAX_H, targetH))
            prevBarH[i] += (targetH - prevBarH[i]) * 0.35
            view.barHeights[i] = prevBarH[i]
        }

        // Pulse dot
        view.dotAlpha = CGFloat(0.7 + sin(t * 3) * 0.3)
        view.needsDisplay = true
    }
}

// ── Processing HUD ───────────────────────────────────────────
func showProcessingHUD() {
    destroyHUD()

    guard let screen = NSScreen.main?.frame else { return }
    let procW: CGFloat = 200
    let x = screen.midX - procW / 2
    let y = screen.maxY - 80

    let win = NSWindow(
        contentRect: NSRect(x: x, y: y, width: procW, height: HUD_H),
        styleMask: [.borderless], backing: .buffered, defer: false
    )
    win.isOpaque = false
    win.backgroundColor = .clear
    win.level = .floating
    win.collectionBehavior = [.canJoinAllSpaces, .stationary]
    win.ignoresMouseEvents = true

    let view = ProcessingHUDView(frame: NSRect(x: 0, y: 0, width: procW, height: HUD_H))
    win.contentView = view
    win.orderFront(nil)
    hudWindow = win

    // Pulse dot
    hudTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
        guard let view = hudWindow?.contentView as? ProcessingHUDView else { return }
        view.dotAlpha = CGFloat(0.5 + sin(CACurrentMediaTime() * 4) * 0.5)
        view.needsDisplay = true
    }

    // Poll /api/health for step updates
    hudPollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { timer in
        let url = URL(string: "http://localhost:\(PORT)/api/health")!
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

            DispatchQueue.main.async {
                guard let view = hudWindow?.contentView as? ProcessingHUDView else { return }

                if let step = json["processingStep"] as? String,
                   let label = STEP_LABELS[step] {
                    view.stepText = label
                    view.stepColor = STEP_COLORS[step] ?? NSColor.white
                    view.needsDisplay = true
                } else if json["processingStep"] is NSNull || json["processingStep"] == nil {
                    let rec = json["recording"] as? Bool ?? false
                    if !rec {
                        // Done
                        view.stepText = "Done"
                        view.stepColor = NSColor(red: 0.0, green: 0.9, blue: 0.5, alpha: 1)
                        view.needsDisplay = true
                        timer.invalidate()
                        hudPollTimer = nil
                        NSSound(named: "Submarine")?.play()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                            destroyHUD()
                        }
                    }
                }
            }
        }.resume()
    }

    // Safety net
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
        if hudPollTimer != nil {
            hudPollTimer?.invalidate()
            hudPollTimer = nil
            destroyHUD()
        }
    }
}

func destroyHUD() {
    hudTimer?.invalidate(); hudTimer = nil
    hudPollTimer?.invalidate(); hudPollTimer = nil
    if let win = hudWindow {
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.1
            win.animator().alphaValue = 0
        }, completionHandler: {
            win.orderOut(nil)
        })
    }
    hudWindow = nil
}

// ── Entry point ──────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
