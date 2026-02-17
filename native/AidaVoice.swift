import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let port: Int

    init(port: Int) {
        self.port = port
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Register as a proper GUI app (required when launched from a shell script)
        NSApp.setActivationPolicy(.regular)

        setupMainMenu()

        // Configure WKWebView
        let webConfig = WKWebViewConfiguration()
        webConfig.mediaTypesRequiringUserActionForPlayback = []

        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        webConfig.defaultWebpagePreferences = prefs

        webView = WKWebView(frame: .zero, configuration: webConfig)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        // Create window
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 420, height: 700)
        let windowWidth: CGFloat = 420
        let windowHeight: CGFloat = 700
        let windowX = screenFrame.maxX - windowWidth - 20
        let windowY = screenFrame.maxY - windowHeight - 20

        window = NSWindow(
            contentRect: NSRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AIDA Voice"
        window.contentView = webView
        window.minSize = NSSize(width: 340, height: 500)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1)

        // Titlebar styling
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)

        // Wait for daemon, then load
        waitForDaemon {
            let url = URL(string: "http://localhost:\(self.port)")!
            self.webView.load(URLRequest(url: url))
            self.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // ── Mic permission grant for WKWebView (macOS 12+) ────────
    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        // Auto-grant mic access for our local daemon
        if origin.host == "localhost" {
            decisionHandler(.grant)
        } else {
            decisionHandler(.prompt)
        }
    }

    // ── Main menu (Cmd+Q, etc.) ───────────────────────────────
    func setupMainMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About AIDA Voice", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit AIDA Voice", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        let appMenuItem = NSMenuItem()
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu (needed for Cmd+C/V/X/A to work in text fields)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))

        let editMenuItem = NSMenuItem()
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        NSApp.mainMenu = mainMenu
    }

    // ── Wait for Node daemon ──────────────────────────────────
    func waitForDaemon(completion: @escaping () -> Void) {
        let url = URL(string: "http://localhost:\(port)/api/health")!
        var attempts = 0
        let maxAttempts = 40

        func check() {
            attempts += 1
            let task = URLSession.shared.dataTask(with: url) { data, response, error in
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    DispatchQueue.main.async { completion() }
                } else if attempts < maxAttempts {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { check() }
                } else {
                    DispatchQueue.main.async { completion() }
                }
            }
            task.resume()
        }
        check()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

// ── Entry point ───────────────────────────────────────────────
var port = 7890
for (i, arg) in CommandLine.arguments.enumerated() {
    if (arg == "-p" || arg == "--port"), i + 1 < CommandLine.arguments.count,
       let p = Int(CommandLine.arguments[i + 1]) {
        port = p
    }
}

let app = NSApplication.shared
let delegate = AppDelegate(port: port)
app.delegate = delegate
app.run()
