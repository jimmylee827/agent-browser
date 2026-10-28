// Agent Browser Input: real input for the agent browser, from the operating
// system — no CDP, no debugger API. Pages see it exactly as they see a person:
// trusted events, real hover, real user activation (sound, fullscreen, popups).
//
// Two routes, both through macOS Accessibility (granted once, to this app only):
//   press   — ask Chrome's accessibility tree to press an element. No cursor
//             movement and no focus change: the window can stay in the background.
//   pointer — mouse events (move, down, up, drag) posted to Chrome's process,
//             or, when a page needs the real cursor, posted system-wide with the
//             cursor put back afterwards.
//   keys    — typed text and named keys, posted to Chrome's process.
//
// It runs as its own LaunchAgent (com.agent-browser.input) and answers JSON on
// 127.0.0.1, authenticated with a shared secret, like the host helper. Being
// its own process is what keeps the Accessibility grant to this app: launched
// by the browser server instead, macOS would attribute it to `node` — every
// node script on the machine.
import AppKit
import ApplicationServices
import Foundation
import IOKit
import Network

let VERSION = "1"

// MARK: - Accessibility

func isTrusted(prompt: Bool) -> Bool {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
  return CGRect(origin: pt, size: sz)
}

func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

func actions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  AXUIElementCopyActionNames(el, &names)
  return (names as? [String]) ?? []
}

func describe(_ el: AXUIElement) -> [String: Any] {
  var d: [String: Any] = [:]
  for (k, a) in [("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("value", kAXValueAttribute)] {
    if let v = attr(el, a) as? String, !v.isEmpty { d[k] = String(v.prefix(80)) }
  }
  if let f = frame(el) { d["frame"] = ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height] }
  return d
}

/// Chrome builds its accessibility tree for web pages only when asked to.
func enableChromeAccessibility(_ app: AXUIElement) -> [String: Any] {
  var out: [String: Any] = [:]
  for a in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
    out[a] = AXUIElementSetAttributeValue(app, a as CFString, kCFBooleanTrue).rawValue
  }
  // Reading the tree once makes Chromium build it.
  _ = attr(app, kAXWindowsAttribute)
  return out
}

/// The window whose frame matches `bounds` (from the page: screenX/Y, outer size).
func window(of app: AXUIElement, matching bounds: CGRect, title: String? = nil) -> AXUIElement? {
  let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  let titled = title.map { t in wins.filter { ((attr($0, kAXTitleAttribute) as? String) ?? "").contains(t) } } ?? wins
  // Position and size both count: two Chrome windows of the same size sit a
  // few points apart, and a loose match pressed the wrong one.
  if let exact = titled.first(where: { distance(frame($0), bounds) < 4 }) { return exact }
  // Too strict to be useful? Take the closest, but only when it is clearly the
  // right one — otherwise say "not found" rather than press the wrong window.
  let ranked = titled.compactMap { w -> (AXUIElement, CGFloat)? in
    guard let f = frame(w) else { return nil }
    return (w, abs(f.minX - bounds.minX) + abs(f.minY - bounds.minY) + abs(f.width - bounds.width) + abs(f.height - bounds.height))
  }.sorted { $0.1 < $1.1 }
  if ranked.count == 1 { return ranked[0].0 }
  if let best = ranked.first, best.1 < 12 { return best.0 }
  return nil
}

/// Bring the app forward and raise one window. Input posted to the process
/// needs the window to be key, and hover needs the cursor over the page.
func focus(_ req: [String: Any]) throws -> [String: Any] {
  let pid = try pidOf(req)
  let app = AXUIElementCreateApplication(pid)
  var raised = false
  if let bounds = rect(req["window"]) {
    _ = enableChromeAccessibility(app)
    for attempt in 0..<8 {
      if let w = window(of: app, matching: bounds, title: req["title"] as? String) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        raised = true
        break
      }
      if attempt < 7 { Thread.sleep(forTimeInterval: 0.25) }
    }
  }
  let running = NSRunningApplication(processIdentifier: pid)
  let activated = running?.activate(options: [.activateAllWindows]) ?? false
  Thread.sleep(forTimeInterval: 0.35)
  let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  let target = rect(req["window"]).flatMap { window(of: app, matching: $0, title: req["title"] as? String) }
  return [
    "raised": raised,
    "raisedFrame": target.flatMap(frame).map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] } ?? [:],
    "activated": activated,
    "frontmostIsChrome": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
    "windows": wins.count,
    "frames": wins.compactMap(frame).map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] },
  ]
}

func distance(_ f: CGRect?, _ b: CGRect) -> CGFloat {
  guard let f = f else { return .greatestFiniteMagnitude }
  return abs(f.minX - b.minX) + abs(f.minY - b.minY) + abs(f.width - b.width) + abs(f.height - b.height)
}

/// The most specific element under a point, searched inside one window — not
/// by hit-testing the screen, so another window on top does not matter.
func element(in root: AXUIElement, at p: CGPoint) -> AXUIElement {
  var current = root
  for _ in 0..<80 {
    let hits = children(current).compactMap { c -> (AXUIElement, CGFloat)? in
      guard let f = frame(c), f.width > 0, f.height > 0, f.contains(p) else { return nil }
      return (c, f.width * f.height)
    }
    guard let next = hits.min(by: { $0.1 < $1.1 })?.0 else { break }
    current = next
  }
  return current
}

// MARK: - Commands

struct Fail: Error { let message: String }

func number(_ v: Any?) -> CGFloat? { (v as? NSNumber).map { CGFloat(truncating: $0) } }

func rect(_ v: Any?) -> CGRect? {
  guard let d = v as? [String: Any], let x = number(d["x"]), let y = number(d["y"]), let w = number(d["width"]), let h = number(d["height"]) else { return nil }
  return CGRect(x: x, y: y, width: w, height: h)
}

func point(_ v: Any?) -> CGPoint? {
  guard let d = v as? [String: Any], let x = number(d["x"]), let y = number(d["y"]) else { return nil }
  return CGPoint(x: x, y: y)
}

func pidOf(_ req: [String: Any]) throws -> pid_t {
  guard let p = req["pid"] as? NSNumber else { throw Fail(message: "pid required") }
  return pid_t(truncating: p)
}

/// Read-only: what the accessibility tree offers for this app — its windows,
/// their frames, and whether switching on manual accessibility took.
func windows(_ req: [String: Any]) throws -> [String: Any] {
  let pid = try pidOf(req)
  let app = AXUIElementCreateApplication(pid)
  let enabled = enableChromeAccessibility(app)
  Thread.sleep(forTimeInterval: 0.8)
  let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  let list = wins.enumerated().map { i, w -> [String: Any] in
    var d: [String: Any] = ["index": i]
    if let f = frame(w) { d["frame"] = ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height] }
    d["title"] = (attr(w, kAXTitleAttribute) as? String) ?? ""
    d["children"] = children(w).count
    return d
  }
  return ["enabled": enabled, "windows": list, "screen": ["x": 0, "y": 0, "width": NSScreen.main?.frame.width ?? 0, "height": NSScreen.main?.frame.height ?? 0]]
}

/// Press the element at a point in one window, through Chrome's accessibility tree.
func press(_ req: [String: Any]) throws -> [String: Any] {
  let pid = try pidOf(req)
  guard let bounds = rect(req["window"]), let p = point(req["point"]) else { throw Fail(message: "window and point required") }
  let app = AXUIElementCreateApplication(pid)
  _ = enableChromeAccessibility(app)
  let action = (req["action"] as? String) ?? kAXPressAction
  // The tree appears a moment after accessibility is switched on.
  var target: AXUIElement?
  var hit: AXUIElement?
  for attempt in 0..<12 {
    if let win = window(of: app, matching: bounds, title: req["title"] as? String) {
      var el: AXUIElement? = element(in: win, at: p)
      hit = el
      while let e = el, !actions(e).contains(action) { el = attr(e, kAXParentAttribute).map { $0 as! AXUIElement } }
      if let e = el, (attr(e, kAXRoleAttribute) as? String) != (kAXWindowRole as String) { target = e; break }
    }
    if attempt < 11 { Thread.sleep(forTimeInterval: 0.25) }
  }
  guard let t = target else {
    throw Fail(message: "nothing at that point offers \(action)" + (hit.map { " (found \(describe($0)))" } ?? " (window not found)"))
  }
  let err = AXUIElementPerformAction(t, action as CFString)
  if err != .success { throw Fail(message: "\(action) failed: AXError \(err.rawValue)") }
  return ["pressed": describe(t), "hit": hit.map(describe) ?? [:]]
}

/// The CoreGraphics number of the window with these bounds, owned by pid.
func windowNumber(pid: pid_t, bounds: CGRect) -> Int? {
  let list = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]]) ?? []
  var best: (Int, CGFloat)?
  for w in list where (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid {
    guard let bd = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: bd),
          let n = (w[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
    let d = distance(r, bounds)
    if d < 24, d < (best?.1 ?? .greatestFiniteMagnitude) { best = (n, d) }
  }
  return best?.0
}

/// Bring the target window forward for the instant a gesture needs it, and
/// remember who had focus so it can be handed back afterwards. macOS delivers
/// input to the frontmost window, so this cannot be skipped — but it is only
/// as long as the gesture.
func raise(_ pid: pid_t, window bounds: CGRect?, title: String?) -> (previous: NSRunningApplication?, raised: Bool) {
  let previous = NSWorkspace.shared.frontmostApplication
  let app = AXUIElementCreateApplication(pid)
  _ = enableChromeAccessibility(app)
  var raised = false
  for _ in 0..<10 {
    if let bounds, let w = window(of: app, matching: bounds, title: title) {
      AXUIElementPerformAction(w, kAXRaiseAction as CFString)
      AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
      AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      raised = true
      break
    }
    Thread.sleep(forTimeInterval: 0.08)
  }
  NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
  // Wait until it really is frontmost, so the events land in the right app.
  for _ in 0..<20 where NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
    Thread.sleep(forTimeInterval: 0.03)
  }
  return (previous, raised)
}

func restore(_ previous: NSRunningApplication?) {
  guard let p = previous, p.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
  p.activate(options: [])
}

/// Mouse events. route "pid": to Chrome only, the cursor stays where it is.
/// route "global": the real cursor moves, and is put back afterwards.
func pointer(_ req: [String: Any]) throws -> [String: Any] {
  let pid = try pidOf(req)
  let route = (req["route"] as? String) ?? "pid"
  guard let events = req["events"] as? [[String: Any]], !events.isEmpty else { throw Fail(message: "events required") }
  let win = rect(req["window"]).flatMap { windowNumber(pid: pid, bounds: $0) }
  let src = CGEventSource(stateID: .hidSystemState)
  let before = CGEvent(source: nil)?.location ?? .zero
  // Front the window for the gesture, then hand focus back.
  var brought: (previous: NSRunningApplication?, raised: Bool) = (nil, false)
  if (req["raise"] as? Bool) ?? true { brought = raise(pid, window: rect(req["window"]), title: req["title"] as? String) }
  var down = false
  var sent = 0
  for ev in events {
    guard let type = ev["type"] as? String, let p = point(ev) else { throw Fail(message: "each event needs type, x, y") }
    let right = (ev["button"] as? String) == "right"
    let kind: CGEventType
    switch type {
    case "move": kind = down ? (right ? .rightMouseDragged : .leftMouseDragged) : .mouseMoved
    case "down": kind = right ? .rightMouseDown : .leftMouseDown; down = true
    case "up": kind = right ? .rightMouseUp : .leftMouseUp; down = false
    default: throw Fail(message: "unknown event type \(type)")
    }
    guard let e = CGEvent(mouseEventSource: src, mouseType: kind, mouseCursorPosition: p, mouseButton: right ? .right : .left) else { continue }
    if type == "down" || type == "up" { e.setIntegerValueField(.mouseEventClickState, value: 1) }
    if let w = win {
      e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w))
      e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w))
    }
    if route == "global" { e.post(tap: .cghidEventTap) } else { e.postToPid(pid) }
    sent += 1
    let wait = number(ev["waitMs"]) ?? 16
    Thread.sleep(forTimeInterval: Double(wait) / 1000)
  }
  if route == "global", (req["restoreCursor"] as? Bool) ?? true {
    CGWarpMouseCursorPosition(before)
    CGAssociateMouseAndMouseCursorPosition(1)
  }
  if (req["restoreFocus"] as? Bool) ?? true { restore(brought.previous) }
  let after = CGEvent(source: nil)?.location ?? .zero
  return [
    "sent": sent, "route": route, "raised": brought.raised, "windowNumber": win as Any,
    "cursorBefore": ["x": before.x, "y": before.y], "cursorAfter": ["x": after.x, "y": after.y],
    "gaveFocusBackTo": brought.previous?.localizedName as Any,
  ]
}

let KEYCODES: [String: CGKeyCode] = [
  "Enter": 36, "Return": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
]

/// Typed text (any characters) and named keys, posted to Chrome's process.
func keys(_ req: [String: Any]) throws -> [String: Any] {
  let pid = try pidOf(req)
  let src = CGEventSource(stateID: .hidSystemState)
  var brought: (previous: NSRunningApplication?, raised: Bool) = (nil, false)
  if (req["raise"] as? Bool) ?? true { brought = raise(pid, window: rect(req["window"]), title: req["title"] as? String) }
  var sent = 0
  if let text = req["text"] as? String {
    for unit in text.utf16 {
      var u = [unit]
      for isDown in [true, false] {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: isDown) else { continue }
        e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        e.postToPid(pid)
      }
      sent += 1
      Thread.sleep(forTimeInterval: 0.02)
    }
  }
  for name in (req["keys"] as? [String]) ?? [] {
    guard let code = KEYCODES[name] else { throw Fail(message: "unknown key \(name)") }
    for isDown in [true, false] { CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: isDown)?.postToPid(pid) }
    sent += 1
    Thread.sleep(forTimeInterval: 0.02)
  }
  if (req["restoreFocus"] as? Bool) ?? true { restore(brought.previous) }
  return ["sent": sent, "raised": brought.raised, "gaveFocusBackTo": brought.previous?.localizedName as Any]
}

/// Seconds since the person last touched the mouse or keyboard.
func idleSeconds() -> Double {
  var iterator: io_iterator_t = 0
  guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"), &iterator) == KERN_SUCCESS else { return -1 }
  defer { IOObjectRelease(iterator) }
  let entry = IOIteratorNext(iterator)
  defer { IOObjectRelease(entry) }
  var props: Unmanaged<CFMutableDictionary>?
  guard IORegistryEntryCreateCFProperties(entry, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS,
        let dict = props?.takeRetainedValue() as? [String: Any], let ns = dict["HIDIdleTime"] as? NSNumber else { return -1 }
  return ns.doubleValue / 1_000_000_000
}

func handle(_ req: [String: Any]) -> [String: Any] {
  let cmd = (req["cmd"] as? String) ?? "status"
  do {
    if cmd == "status" { return ["ok": true, "version": VERSION, "trusted": isTrusted(prompt: false), "idleSeconds": idleSeconds()] }
    guard isTrusted(prompt: false) else {
      return ["ok": false, "code": "NOT_TRUSTED", "error": "Agent Browser Input is not allowed to use Accessibility: System Settings → Privacy & Security → Accessibility → switch on Agent Browser Input"]
    }
    switch cmd {
    case "windows": return try windows(req).merging(["ok": true]) { a, _ in a }
    case "focus": return try focus(req).merging(["ok": true]) { a, _ in a }
    case "press": return try press(req).merging(["ok": true]) { a, _ in a }
    case "pointer": return try pointer(req).merging(["ok": true]) { a, _ in a }
    case "keys": return try keys(req).merging(["ok": true]) { a, _ in a }
    default: return ["ok": false, "error": "unknown command \(cmd)"]
    }
  } catch let f as Fail {
    return ["ok": false, "error": f.message]
  } catch {
    return ["ok": false, "error": "\(error)"]
  }
}

// MARK: - Server

func readSecret() -> String? {
  let file = ProcessInfo.processInfo.environment["AB_INPUT_SECRET_FILE"] ?? (NSHomeDirectory() + "/.agent-chrome/input-helper-secret")
  return (try? String(contentsOfFile: file, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
}

func respond(_ conn: NWConnection, _ status: Int, _ body: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
  let head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n"
  conn.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in conn.cancel() })
}

func serve(port: UInt16, secret: String) throws {
  let params = NWParameters.tcp
  params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
  params.allowLocalEndpointReuse = true
  let listener = try NWListener(using: params)
  let work = DispatchQueue(label: "input")
  listener.newConnectionHandler = { conn in
    conn.start(queue: work)
    var buffer = Data()
    func receive() {
      conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, error in
        if let d = data { buffer.append(d) }
        if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
          let head = String(decoding: buffer[..<range.lowerBound], as: UTF8.self)
          let length = head.split(separator: "\r\n").compactMap { line -> Int? in
            let parts = line.split(separator: ":", maxSplits: 1)
            return parts.count == 2 && parts[0].lowercased() == "content-length" ? Int(parts[1].trimmingCharacters(in: .whitespaces)) : nil
          }.first ?? 0
          let body = buffer[range.upperBound...]
          if body.count >= length {
            let req = (try? JSONSerialization.jsonObject(with: Data(body.prefix(length)))) as? [String: Any] ?? [:]
            guard (req["secret"] as? String) == secret else { return respond(conn, 403, ["ok": false, "error": "bad secret"]) }
            return respond(conn, 200, handle(req))
          }
        }
        if done || error != nil { conn.cancel(); return }
        receive()
      }
    }
    receive()
  }
  listener.start(queue: work)
}

let args = CommandLine.arguments.dropFirst()
switch args.first ?? "serve" {
case "status":
  print(String(decoding: try JSONSerialization.data(withJSONObject: handle(["cmd": "status"])), as: UTF8.self))
case "prompt":
  print(isTrusted(prompt: true))
default:
  guard let secret = readSecret(), !secret.isEmpty else {
    FileHandle.standardError.write(Data("no secret: run `npm run input-helper:install`\n".utf8))
    exit(1)
  }
  let port = UInt16(ProcessInfo.processInfo.environment["AB_INPUT_PORT"] ?? "8790") ?? 8790
  // Ask once at start: macOS shows its dialog and lists this app, switched
  // off, in Privacy & Security → Accessibility for the person to switch on.
  if !isTrusted(prompt: true) { FileHandle.standardError.write(Data("waiting for Accessibility permission\n".utf8)) }
  do {
    try serve(port: port, secret: secret)
  } catch {
    FileHandle.standardError.write(Data("cannot listen on \(port): \(error)\n".utf8))
    exit(1)
  }
  FileHandle.standardError.write(Data("Agent Browser Input \(VERSION) on 127.0.0.1:\(port)\n".utf8))
  NSApplication.shared.setActivationPolicy(.prohibited)
  RunLoop.main.run()
}
