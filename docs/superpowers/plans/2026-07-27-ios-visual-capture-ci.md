# iOS Visual-Capture CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single repeatable script (`ios/scripts/capture-demo.sh`) that drives a realistic live-conversation session in the iOS simulator and captures light+dark screenshots and a demo video of the real screens, plus the on-demand GitHub workflow that runs the same script.

**Architecture:** Compile inert test seams into the App (auth bypass via a seeded dev key, a selective `URLProtocol` network stub that replays canned Claude replies, accessibility identifiers, and an optional in-app transcript seed) — all gated behind the `-uiTestCapture` launch argument so production behavior is untouched. A new UITest target + shared scheme taps Start on a real screen and snapshots checkpoints. All *pure* seam logic (host-match predicate, canned-fixture shape, response-envelope builder) lives in `ShutUpAndListenKit` with real `swift test` coverage; the App/script glue is Mac-build-gated and verified by running Phase 1 on a Mac.

**Tech Stack:** Swift 6 / SwiftUI, XCUITest, `ShutUpAndListenKit` SwiftPM package, `xcodebuild` + `simctl`, Homebrew (BlackHole 2ch, switchaudio-osx, xcparse), GitHub Actions (macOS runner).

---

## Context an engineer needs before starting

- **Two build worlds.** The App target (`ios/App/*`) builds **only on macOS/Xcode**. The Linux devcontainer can build/test only the `ios/ShutUpAndListenKit` package via `swift test`. So: Kit tasks (1–3) are developed and tested **in-container with TDD**; App/project/script tasks (4–12) are written here but their real verification is the **Phase-1 Mac run** in Task 11.
- **The app is talk-first.** `ShutUpAndListenApp` opens straight into `SessionView` (the live session screen). There is no login wall — Sign in with Apple only matters when the listener needs the model. So "auth bypass" here means: seed a fake **developer API key** into the Keychain so `SessionController.resolveService()` returns a working `ClaudeClient` pointed at `api.anthropic.com`, which our stub intercepts. We also flip `hasOnboarded` so the onboarding cover doesn't block the screen.
- **How the network stub reaches production code paths.** `ClaudeClient` and `ProxyClient` both default their `URLSession` to `.shared`. A `URLProtocol` registered globally via `URLProtocol.registerClass(_:)` **is** consulted by `.shared`. `SFSpeechRecognizer`'s server-based recognition runs out-of-process (a system daemon), so it never touches our `URLSession` — but we still make `canInit` host-selective (belt and suspenders, per the design).
- **QuestionCard is gone.** The live screen is now hint-line-only (commit `99ddae0` deleted `QuestionCard`/`QuestionChip`). Screenshot checkpoints therefore target the **current** UI: idle/ready, live transcript, an inline listener reply, and the "SUGGESTED" hint line.
- **The `App/` folder is a `PBXFileSystemSynchronizedRootGroup`.** New files under `ios/App/**` are auto-compiled into the app target and JSON under `ios/App/Resources/` is auto-bundled — **no `project.pbxproj` edit needed for App source/resource files.** Only the new UITest target requires project changes (Task 9).
- **Run Kit tests with:** `swift test --package-path ios/ShutUpAndListenKit`. Baseline is green (81 tests) before you start.

## File Structure

Files this plan creates or modifies, by responsibility:

**Kit — pure, testable in-container (`ios/ShutUpAndListenKit/`)**
- Create `Sources/ClaudeClient/CaptureSupport.swift` — `CaptureHosts` (host-match predicate), `CaptureFixture` (canned-reply model + decode), `CaptureResponder` (structured-request detector + Messages-API response-envelope builder). One file: it's the whole capture-seam vocabulary and it's small.
- Create `Tests/ClaudeClientTests/CaptureSupportTests.swift` — unit tests for all three.

**App — Mac-build-gated glue (`ios/App/`)**
- Create `Support/CaptureSeam.swift` — flag detection, install (seed Keychain + `hasOnboarded`, load fixture, register protocol).
- Create `Support/CaptureURLProtocol.swift` — the thin `URLProtocol` subclass over Kit logic.
- Create `Resources/capture-fixture.json` — the bundled canned replies/candidates/seed transcript.
- Modify `ShutUpAndListenApp.swift` — call `CaptureSeam.installIfNeeded()` in `init`.
- Modify `SessionController.swift` — optional in-app transcript/hint seed under `-captureSeedTranscript`.
- Modify `UI/SessionView.swift` — accessibility identifiers on start button, ring, transcript, hint, listener reply.

**Project + UITest (`ios/`)**
- Modify `ShutUpAndListen.xcodeproj` — new `ShutUpAndListenUITests` target (via Xcode GUI) and a **shared** `ShutUpAndListen` scheme.
- Create `UITests/CaptureUITests.swift` — taps Start, snapshots checkpoints, never asserts on transcript text.

**Scripts + fixtures + CI (`ios/`, `.github/`)**
- Create `scripts/make-fixture-audio.sh` — generates the fixture `.wav` from macOS `say`.
- Create `fixtures/demo-conversation.wav` — the checked-in scripted audio.
- Create `scripts/capture-demo.sh` — the pipeline source of truth.
- Create `.github/workflows/ios-visual.yml` — Phase 2 `workflow_dispatch` wrapper.

---

## Task 1: Kit — `CaptureHosts` host-match predicate

**Files:**
- Create: `ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift`
- Test: `ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift`:

```swift
// Unit tests for the CI visual-capture seam logic that lives in the Kit:
// which hosts the stub intercepts, the canned-fixture shape, and the
// Messages-API response envelope the stub replays. Pure — no network.

import XCTest
import ClaudeClient
import TurnEngine

final class CaptureSupportTests: XCTestCase {
    // ── CaptureHosts ──

    func testInterceptsClaudeAndProxyHosts() {
        XCTAssertTrue(CaptureHosts.shouldIntercept(URL(string: "https://api.anthropic.com/v1/messages")))
        XCTAssertTrue(CaptureHosts.shouldIntercept(URL(string: "https://api.shutupandlisten.sh/v1/listener")))
    }

    func testInterceptsSubdomainsOfInterceptedHosts() {
        XCTAssertTrue(CaptureHosts.shouldIntercept(URL(string: "https://edge.api.anthropic.com/v1/messages")))
    }

    func testPassesThroughAppleSpeechAndNilHosts() {
        XCTAssertFalse(CaptureHosts.shouldIntercept(URL(string: "https://guzzoni.apple.com/recognize")))
        XCTAssertFalse(CaptureHosts.shouldIntercept(nil))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --package-path ios/ShutUpAndListenKit --filter CaptureSupportTests`
Expected: FAIL to **compile** with "cannot find 'CaptureHosts' in scope".

- [ ] **Step 3: Write minimal implementation**

Create `ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift`:

```swift
// CI visual-capture seam logic (design: 2026-07-27-ios-visual-capture-ci).
//
// PURE and platform-agnostic so it gets real `swift test` coverage in the
// devcontainer. The App layer (CaptureURLProtocol / CaptureSeam) is a thin
// glue over these three pieces; nothing here does I/O.

import Foundation
import TurnEngine

/// Which hosts the capture stub replaces with canned replies. Everything else
/// — notably Apple's speech-recognition endpoints — passes through untouched so
/// the real SpeechTranscriber still works.
public enum CaptureHosts {
    /// Hosts (and their subdomains) intercepted during a capture run.
    public static let intercepted: Set<String> = [
        "api.anthropic.com",
        "api.shutupandlisten.sh",
    ]

    /// True when `url`'s host equals — or is a subdomain of — an intercepted host.
    public static func shouldIntercept(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return intercepted.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --package-path ios/ShutUpAndListenKit --filter CaptureSupportTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift \
        ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift
git commit -m "feat(ios-kit): CaptureHosts host-match predicate for the capture stub"
```

---

## Task 2: Kit — `CaptureFixture` canned-reply model

**Files:**
- Modify: `ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift`
- Test: `ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift`

- [ ] **Step 1: Write the failing test**

Add these methods inside the `CaptureSupportTests` class in `ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift`:

```swift
    // ── CaptureFixture ──

    func testDecodesFixtureShape() throws {
        let json = """
        {
          "listenerReplies": ["hi there"],
          "analystCandidates": [
            { "text": "Which step could you defer?", "register": "question", "anchor": "config" }
          ],
          "seedTranscript": ["one", "two"]
        }
        """
        let fixture = try CaptureFixture.decode(from: Data(json.utf8))
        XCTAssertEqual(fixture.listenerReplies, ["hi there"])
        XCTAssertEqual(fixture.seedTranscript, ["one", "two"])
        XCTAssertEqual(fixture.analystCandidates.first?.register, "question")
        XCTAssertEqual(fixture.analystCandidates.first?.text, "Which step could you defer?")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --package-path ios/ShutUpAndListenKit --filter CaptureSupportTests`
Expected: FAIL to compile with "cannot find 'CaptureFixture' in scope".

- [ ] **Step 3: Write minimal implementation**

Append to `ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift`:

```swift
/// The canned data the capture stub replays. `analystCandidates` reuses
/// TurnEngine's wire type so the analyst JSON round-trips through the real
/// `AnalystResult` decoder. `seedTranscript` drives the optional in-app replay
/// fallback (design §reliability) — display only, never the network.
public struct CaptureFixture: Codable, Equatable, Sendable {
    public var listenerReplies: [String]
    public var analystCandidates: [AnalystCandidate]
    public var seedTranscript: [String]

    public init(
        listenerReplies: [String],
        analystCandidates: [AnalystCandidate],
        seedTranscript: [String]
    ) {
        self.listenerReplies = listenerReplies
        self.analystCandidates = analystCandidates
        self.seedTranscript = seedTranscript
    }

    public static func decode(from data: Data) throws -> CaptureFixture {
        try JSONDecoder().decode(CaptureFixture.self, from: data)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --package-path ios/ShutUpAndListenKit --filter CaptureSupportTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift \
        ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift
git commit -m "feat(ios-kit): CaptureFixture canned-reply model for the capture stub"
```

---

## Task 3: Kit — `CaptureResponder` (structured detector + envelope builder)

**Files:**
- Modify: `ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift`
- Test: `ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift`

Context: the stub returns Messages-API-shaped JSON (`content: [{type,text}]`, `stop_reason`, `usage`) so `ClaudeClient`'s existing decoder accepts it. A **listener** call's `text` is the next canned reply string; an **analyst** call (any request carrying `output_config`) returns `text` = a JSON-encoded `AnalystResult`, which `ClaudeClient.analyze` re-decodes.

- [ ] **Step 1: Write the failing test**

Add these methods inside `CaptureSupportTests`:

```swift
    // ── CaptureResponder ──

    func testDetectsStructuredRequestByOutputConfig() {
        let analyst = Data(#"{"model":"m","output_config":{"format":{}}}"#.utf8)
        let listener = Data(#"{"model":"m","messages":[]}"#.utf8)
        XCTAssertTrue(CaptureResponder.isStructuredRequest(body: analyst))
        XCTAssertFalse(CaptureResponder.isStructuredRequest(body: listener))
        XCTAssertFalse(CaptureResponder.isStructuredRequest(body: nil))
    }

    func testListenerResponseCarriesNthReply() throws {
        let fixture = CaptureFixture(
            listenerReplies: ["first", "second"], analystCandidates: [], seedTranscript: []
        )
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: false, callIndex: 1)
        XCTAssertEqual(try Self.text(in: data), "second")
    }

    func testListenerResponsePastEndIsSilence() throws {
        let fixture = CaptureFixture(
            listenerReplies: ["only"], analystCandidates: [], seedTranscript: []
        )
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: false, callIndex: 5)
        XCTAssertEqual(try Self.text(in: data), "")
    }

    func testAnalystResponseDecodesToAnalystResult() throws {
        let fixture = CaptureFixture(
            listenerReplies: [],
            analystCandidates: [AnalystCandidate(text: "q?", register: "question", anchor: "a")],
            seedTranscript: []
        )
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: true, callIndex: 0)
        let text = try Self.text(in: data)
        let result = try JSONDecoder().decode(AnalystResult.self, from: Data(text.utf8))
        XCTAssertEqual(result.candidates.first?.text, "q?")
    }

    func testResponseEnvelopeDecodesInClaudeClient() throws {
        // The envelope must satisfy ClaudeClient's own decoder shape: a text
        // content block plus a usage block. Assert the structural keys are present.
        let fixture = CaptureFixture(listenerReplies: ["ok"], analystCandidates: [], seedTranscript: [])
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: false, callIndex: 0)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(json["content"])
        XCTAssertNotNil(json["usage"])
        XCTAssertEqual(json["stop_reason"] as? String, "end_turn")
    }

    /// Pull the first content block's text out of a Messages-API envelope.
    private static func text(in data: Data) throws -> String {
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let content = try XCTUnwrap(json["content"] as? [[String: Any]])
        return try XCTUnwrap(content.first?["text"] as? String)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --package-path ios/ShutUpAndListenKit --filter CaptureSupportTests`
Expected: FAIL to compile with "cannot find 'CaptureResponder' in scope".

- [ ] **Step 3: Write minimal implementation**

Append to `ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift`:

```swift
/// Builds the canned Messages-API response the stub returns, and classifies
/// requests. Kept here (not in the URLProtocol) so it is `swift test`-covered.
public enum CaptureResponder {
    /// A request is "structured" (analyst/coverage) when its JSON body carries
    /// an `output_config`. The capture flow only ever fires the analyst, so the
    /// stub treats every structured request as an analyst request.
    public static func isStructuredRequest(body: Data?) -> Bool {
        guard let body,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return false }
        return json["output_config"] != nil
    }

    /// The response body for an intercepted request. `isAnalyst` → a JSON
    /// `AnalystResult` as the text block; otherwise the `callIndex`-th listener
    /// reply (empty string past the end = the model choosing silence).
    public static func responseData(fixture: CaptureFixture, isAnalyst: Bool, callIndex: Int) -> Data {
        let text: String
        if isAnalyst {
            let result = AnalystResult(candidates: fixture.analystCandidates)
            text = (try? String(data: JSONEncoder().encode(result), encoding: .utf8) ?? "") ?? ""
        } else if callIndex >= 0, callIndex < fixture.listenerReplies.count {
            text = fixture.listenerReplies[callIndex]
        } else {
            text = ""
        }

        let envelope: [String: Any] = [
            "id": "msg_capture",
            "type": "message",
            "role": "assistant",
            "stop_reason": "end_turn",
            "content": [["type": "text", "text": text]],
            "usage": [
                "input_tokens": 120,
                "output_tokens": 24,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            ],
        ]
        // The keys above are static and JSON-safe, so serialization cannot fail;
        // fall back to an empty object rather than force-unwrap.
        return (try? JSONSerialization.data(withJSONObject: envelope)) ?? Data("{}".utf8)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --package-path ios/ShutUpAndListenKit --filter CaptureSupportTests`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the full Kit suite to confirm no regression**

Run: `swift test --package-path ios/ShutUpAndListenKit`
Expected: PASS (previous baseline + the new CaptureSupport tests).

- [ ] **Step 6: Commit**

```bash
git add ios/ShutUpAndListenKit/Sources/ClaudeClient/CaptureSupport.swift \
        ios/ShutUpAndListenKit/Tests/ClaudeClientTests/CaptureSupportTests.swift
git commit -m "feat(ios-kit): CaptureResponder builds canned Messages-API envelopes for the stub"
```

---

## Task 4: App — `CaptureURLProtocol`

**Files:**
- Create: `ios/App/Support/CaptureURLProtocol.swift`

Note: this and all remaining App tasks compile only on a Mac. There is no in-container test; verification is deferred to the Task 11 Mac run. Write the complete code now.

- [ ] **Step 1: Write the URLProtocol**

Create `ios/App/Support/CaptureURLProtocol.swift`:

```swift
// The CI-only network stub. Registered by CaptureSeam (only under
// -uiTestCapture); intercepts exactly the Claude/proxy hosts and replays canned
// replies from the bundled fixture, so listener/analyst REPLIES are
// deterministic even though real speech transcription is not. Every other host
// (Apple speech) passes through untouched. All decision logic lives in the Kit
// (CaptureHosts / CaptureResponder); this class is thin glue.

import ClaudeClient
import Foundation

final class CaptureURLProtocol: URLProtocol {
    /// The canned data, installed once by `CaptureSeam` before any request.
    nonisolated(unsafe) static var fixture = CaptureFixture(
        listenerReplies: [], analystCandidates: [], seedTranscript: []
    )

    // Listener replies are walked in order across the run. A fresh app process
    // per launch resets this; the lock guards the simulator's concurrent calls.
    nonisolated(unsafe) private static var listenerCallIndex = 0
    private static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool {
        CaptureSeam.isActive && CaptureHosts.shouldIntercept(request.url)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // The loading system may have converted httpBody into a stream.
        let body = request.httpBody ?? Self.drain(request.httpBodyStream)
        let isAnalyst = CaptureResponder.isStructuredRequest(body: body)

        let index: Int = {
            guard !isAnalyst else { return 0 }
            Self.lock.lock(); defer { Self.lock.unlock() }
            let i = Self.listenerCallIndex
            Self.listenerCallIndex += 1
            return i
        }()

        let data = CaptureResponder.responseData(
            fixture: Self.fixture, isAnalyst: isAnalyst, callIndex: index
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add ios/App/Support/CaptureURLProtocol.swift
git commit -m "feat(ios): CaptureURLProtocol — CI-only selective network stub"
```

---

## Task 5: App — `CaptureSeam` install + bundled fixture + App wiring

**Files:**
- Create: `ios/App/Support/CaptureSeam.swift`
- Create: `ios/App/Resources/capture-fixture.json`
- Modify: `ios/App/ShutUpAndListenApp.swift`

- [ ] **Step 1: Write the seam installer**

Create `ios/App/Support/CaptureSeam.swift`:

```swift
// The one place the capture seams are switched on. Everything here is inert
// unless the app was launched with -uiTestCapture, so production behavior is
// untouched. Install order matters: seed auth + onboarding and register the
// network stub BEFORE any view renders or any request is made.

import ClaudeClient
import Foundation

enum CaptureSeam {
    /// Launch argument that arms the whole capture path.
    static let flag = "-uiTestCapture"
    /// Optional fallback (design §reliability): drive the on-screen transcript
    /// and hint from the fixture instead of real audio, for when host mic
    /// injection is unavailable (e.g. the GitHub runner).
    static let seedTranscriptFlag = "-captureSeedTranscript"

    static var isActive: Bool { CommandLine.arguments.contains(flag) }
    static var shouldSeedTranscript: Bool { CommandLine.arguments.contains(seedTranscriptFlag) }

    /// Arm the seams. Called first thing from ShutUpAndListenApp.init.
    static func installIfNeeded() {
        guard isActive else { return }
        // Skip onboarding so the session screen is visible immediately.
        UserDefaults.standard.set(true, forKey: "hasOnboarded")
        // Auth bypass: a fake developer key routes the listener through
        // ClaudeClient → api.anthropic.com, which CaptureURLProtocol intercepts.
        KeychainStore.apiKey = "ci-capture-fake-key"
        if let fixture = loadFixture() {
            CaptureURLProtocol.fixture = fixture
        }
        URLProtocol.registerClass(CaptureURLProtocol.self)
    }

    static func loadFixture() -> CaptureFixture? {
        guard let url = Bundle.main.url(forResource: "capture-fixture", withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return try? CaptureFixture.decode(from: data)
    }
}
```

- [ ] **Step 2: Write the bundled fixture**

Create `ios/App/Resources/capture-fixture.json`:

```json
{
  "listenerReplies": [
    "You said the wall is configuration — which single setup step feels most skippable before someone sees their first real result?"
  ],
  "analystCandidates": [
    {
      "text": "Which onboarding step could you defer until after the first real result?",
      "register": "question",
      "anchor": "wall of configuration"
    },
    {
      "text": "Showing value before setup quietly flips the usual order of trust.",
      "register": "reflection",
      "anchor": "see one real result first"
    }
  ],
  "seedTranscript": [
    "So I've been thinking about why our onboarding drops off.",
    "I think the issue is we ask for too much before showing any value.",
    "What if we flipped it — let them see one real result first, then ask for the setup?"
  ]
}
```

- [ ] **Step 3: Wire the installer into App init**

In `ios/App/ShutUpAndListenApp.swift`, add an `init()` to the `ShutUpAndListenApp` struct. Change:

```swift
@main
struct ShutUpAndListenApp: App {
    @StateObject private var controller = SessionController()
    @StateObject private var accountStore = AccountStore()
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @Environment(\.scenePhase) private var scenePhase
```

to:

```swift
@main
struct ShutUpAndListenApp: App {
    @StateObject private var controller = SessionController()
    @StateObject private var accountStore = AccountStore()
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Arm the CI capture seams before any view renders or request is made.
        // Inert unless launched with -uiTestCapture.
        CaptureSeam.installIfNeeded()
    }
```

- [ ] **Step 4: Commit**

```bash
git add ios/App/Support/CaptureSeam.swift \
        ios/App/Resources/capture-fixture.json \
        ios/App/ShutUpAndListenApp.swift
git commit -m "feat(ios): CaptureSeam install — auth bypass, bundled fixture, stub registration"
```

---

## Task 6: App — accessibility identifiers on capture checkpoints

**Files:**
- Modify: `ios/App/UI/SessionView.swift`

Stable identifiers let the UITest wait on and snapshot real elements. Add five, using the exact string constants the UITest (Task 10) references.

- [ ] **Step 1: Identify the ring**

In `ios/App/UI/SessionView.swift`, in the `stage` computed property, find:

```swift
            PatienceRing(
                phase: ringPhase,
                fill: ringFill,
                levelDb: controller.inputLevelDb
            )
            .frame(width: 220, height: 220)
```

Change the trailing modifier to:

```swift
            PatienceRing(
                phase: ringPhase,
                fill: ringFill,
                levelDb: controller.inputLevelDb
            )
            .frame(width: 220, height: 220)
            .accessibilityIdentifier("session.ring")
```

- [ ] **Step 2: Identify the live transcript**

In the `liveTranscript` property, find `.frame(maxHeight: 260)` and add the identifier immediately after it:

```swift
            .frame(maxHeight: 260)
            .accessibilityIdentifier("session.transcript")
```

- [ ] **Step 3: Identify the listener reply line**

In `liveEntry(_:)`, the `else` branch renders the listener line. Change:

```swift
        } else {
            Text(entry.text)
                .font(.system(.subheadline, design: .serif).italic())
                .foregroundStyle(Color.sulAccent)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
```

to:

```swift
        } else {
            Text(entry.text)
                .font(.system(.subheadline, design: .serif).italic())
                .foregroundStyle(Color.sulAccent)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("session.listenerReply")
        }
```

- [ ] **Step 4: Identify the hint line**

In `hintLine`, find the end of the outer `Group { ... }` modifier chain and add the identifier after `.accessibilityLabel(...)`:

```swift
        .accessibilityElement()
        .accessibilityLabel(controller.hint.first.map { "Suggested: \($0.text)" } ?? "")
        .accessibilityIdentifier("session.hint")
    }
```

- [ ] **Step 5: Identify the start/stop button**

In `controls`, find the main circular button and add the identifier after its `.accessibilityLabel`:

```swift
            .buttonStyle(.plain)
            .accessibilityLabel(controller.isRunning ? "End session" : "Start talking")
            .accessibilityIdentifier("session.startButton")
```

- [ ] **Step 6: Commit**

```bash
git add ios/App/UI/SessionView.swift
git commit -m "feat(ios): accessibility identifiers on session ring, transcript, reply, hint, start"
```

---

## Task 7: App — optional in-app transcript/hint seed (audio-injection fallback)

**Files:**
- Modify: `ios/App/SessionController.swift`

Design §reliability: if host mic injection yields nothing (or is unavailable on the runner), the `-captureSeedTranscript` flag drives the on-screen transcript and hint from the fixture so the "live transcript" and "SUGGESTED" checkpoints still render real screens. This is **display-only** — it never fakes the network path and is off unless the extra flag is present. Note the analyst only calls the model when `transcriber.fullText` is non-empty, so the hint must be set directly here rather than via the transcriber. Note: under any `-uiTestCapture` run, `startSession()` skips the interactive mic/speech permission requests (they are pre-granted by `capture-demo.sh` via `simctl privacy grant`), so a TCC dialog never blocks the session from going live.

- [ ] **Step 1: Add the seed helper**

In `ios/App/SessionController.swift`, add this method to `SessionController` (place it near `startSession`, e.g. just after `stopSession()`):

```swift
    /// CI capture fallback (design §reliability): when launched with
    /// -captureSeedTranscript, paint the fixture's transcript + top hint onto
    /// the live screen so the "live transcript" and "SUGGESTED" checkpoints
    /// render even if host mic injection produced no audio. Display only — the
    /// network path is untouched; inert unless the flag is present.
    private func seedCaptureStateIfNeeded() {
        guard CaptureSeam.shouldSeedTranscript else { return }
        let fixture = CaptureURLProtocol.fixture
        var seeded: [TranscriptEntry] = []
        for (i, line) in fixture.seedTranscript.enumerated() where !line.isEmpty {
            seeded.append(TranscriptEntry(
                speaker: .thinker, text: line, tier: nil, turn: i + 1,
                startMs: Double(i) * 4000, endMs: Double(i) * 4000 + 3500
            ))
        }
        if let reply = fixture.listenerReplies.first, !reply.isEmpty {
            seeded.append(TranscriptEntry(
                speaker: .listener, text: reply, tier: .question,
                turn: fixture.seedTranscript.count, startMs: Double(seeded.count) * 4000
            ))
        }
        transcript = seeded
        hint = fixture.analystCandidates.prefix(2).compactMap { candidate in
            guard let register = Tier(rawValue: candidate.register) else { return nil }
            return Candidate(text: candidate.text, register: register, anchorPosition: 0)
        }
    }
```

- [ ] **Step 2: Call it at the end of `startSession`**

In `startSession()`, find the tail where the session goes live:

```swift
        isRunning = true
        machineState = .listening
```

Insert the seed call immediately after `machineState = .listening`:

```swift
        isRunning = true
        machineState = .listening
        seedCaptureStateIfNeeded()
```

- [ ] **Step 3: Commit**

```bash
git add ios/App/SessionController.swift
git commit -m "feat(ios): -captureSeedTranscript fallback paints fixture transcript+hint for capture"
```

---

## Task 8: Fixture audio generator + checked-in `.wav`

**Files:**
- Create: `ios/scripts/make-fixture-audio.sh`
- Create: `ios/fixtures/demo-conversation.wav` (generated on a Mac by the script)

- [ ] **Step 1: Write the generator**

Create `ios/scripts/make-fixture-audio.sh`:

```bash
#!/usr/bin/env bash
# Regenerate ios/fixtures/demo-conversation.wav from macOS `say`. Run on a Mac
# and commit the resulting .wav. 16 kHz mono LEI16 is what SFSpeech wants; the
# script matches the seed transcript in App/Resources/capture-fixture.json.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
OUT="$DIR/fixtures/demo-conversation.wav"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DIR/fixtures"

say -v Samantha -r 172 -o "$TMP/line.aiff" \
"So I've been thinking about why our onboarding drops off. \
I think the issue is we ask for too much before showing any value. \
People sign up, and then immediately hit a wall of configuration. \
What if we flipped it — let them see one real result first, then ask for the setup?"

afconvert "$TMP/line.aiff" "$OUT" -d LEI16@16000 -f WAVE -c 1
echo "wrote $OUT"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x ios/scripts/make-fixture-audio.sh`
Expected: no output.

- [ ] **Step 3: Generate the `.wav` (on a Mac)**

Run (Mac only): `./ios/scripts/make-fixture-audio.sh`
Expected: prints `wrote .../ios/fixtures/demo-conversation.wav`; the file is ~1–2 s of speech, a few hundred KB.

Note for in-container execution: `say`/`afconvert` do not exist on Linux. Commit the script now; the `.wav` is produced and committed during the Task 11 Mac run.

- [ ] **Step 4: Commit the script**

```bash
git add ios/scripts/make-fixture-audio.sh
git commit -m "feat(ios): make-fixture-audio.sh generates the demo conversation .wav"
```

---

## Task 9: Project — UITest target + shared scheme

**Files:**
- Modify: `ios/ShutUpAndListen.xcodeproj` (target + shared scheme)

Hand-editing `project.pbxproj` to add a target is error-prone (Xcode assigns UUIDs and rewrites the file). Create the target through Xcode so the project stays internally consistent, then share the scheme and commit both. **All steps are Mac-only.**

- [ ] **Step 1: Create the UITest target**

In Xcode, open `ios/ShutUpAndListen.xcodeproj`. File → New → Target… → iOS → **UI Testing Bundle** → Next. Set:
- Product Name: `ShutUpAndListenUITests`
- Team: `47BY3273S8` (matches the app target)
- Target to be Tested: `ShutUpAndListen`
- Bundle Identifier: `sh.shutupandlisten.ios.uitests`

Click Finish. Xcode creates the target, a `ShutUpAndListenUITests` group with a starter test file, and a target dependency on the app.

- [ ] **Step 2: Point the target's sources at `ios/UITests/`**

Delete the auto-generated starter files (`ShutUpAndListenUITests.swift`, `ShutUpAndListenUITestsLaunchTests.swift`) — move to Trash. Create the directory the real test will live in:

Run (Mac): `mkdir -p ios/UITests`

Then in Xcode, right-click the `ShutUpAndListenUITests` group → Add Files… and add the `ios/UITests` folder as a **folder reference synchronized group** (Xcode 16 "Add Files" creates a synchronized group for a folder), ensuring membership in the `ShutUpAndListenUITests` target. (The `CaptureUITests.swift` file is added in Task 10; an empty folder is fine here.)

- [ ] **Step 3: Set the deployment target to match the app**

Select the `ShutUpAndListenUITests` target → Build Settings → set **iOS Deployment Target** to `17.0` (matching the app).

- [ ] **Step 4: Share the scheme**

Product → Scheme → Manage Schemes… In the row for `ShutUpAndListen`, check the **Shared** checkbox. Confirm the `ShutUpAndListenUITests` target appears under the scheme's **Test** action (Product → Scheme → Edit Scheme → Test → Info; add it if missing). Close.

This writes `ios/ShutUpAndListen.xcodeproj/xcshareddata/xcschemes/ShutUpAndListen.xcscheme`.

- [ ] **Step 5: Verify the scheme is shared and lists the test target**

Run (Mac): `xcodebuild -list -project ios/ShutUpAndListen.xcodeproj`
Expected: under `Schemes:` you see `ShutUpAndListen`; under `Targets:` you see both `ShutUpAndListen` and `ShutUpAndListenUITests`.

Run (Mac): `test -f ios/ShutUpAndListen.xcodeproj/xcshareddata/xcschemes/ShutUpAndListen.xcscheme && echo shared`
Expected: prints `shared`.

- [ ] **Step 6: Commit**

```bash
git add ios/ShutUpAndListen.xcodeproj
git commit -m "chore(ios): add ShutUpAndListenUITests target and shared ShutUpAndListen scheme"
```

---

## Task 10: UITest — checkpoint capture

**Files:**
- Create: `ios/UITests/CaptureUITests.swift`

The test taps Start on the real screen and snapshots checkpoints as `XCTAttachment`s. It **never asserts on transcript text** (audio is the accepted flaky element) — waits use generous timeouts and their boolean results are ignored; only a failure to launch or find the Start button fails the run. Appearance (light/dark) is toggled by the *script* (`simctl ui`), which runs this test twice into separate result bundles — so the test itself is appearance-agnostic.

- [ ] **Step 1: Write the UITest**

Create `ios/UITests/CaptureUITests.swift`:

```swift
// Drives one realistic capture pass: launch into the session screen, tap Start
// (a real tap, for realism), and snapshot the checkpoints the reviewer wants to
// see. Deliberately tolerant — transcription of injected audio is nondeterministic,
// so we capture whatever the real screen shows and never assert on words. The
// script sets light/dark appearance around each run and collects screenshots
// from the result bundle with xcparse.

import XCTest

final class CaptureUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    func testCaptureSession() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestCapture"]
        // The runner (or a developer without working mic injection) sets this to
        // paint the fixture transcript/hint so the checkpoints still render.
        if ProcessInfo.processInfo.environment["CAPTURE_SEED_TRANSCRIPT"] == "1" {
            app.launchArguments.append("-captureSeedTranscript")
        }
        app.launch()

        // 01 — idle / ready.
        snapshot(app, "01-idle")

        // Tap Start (fail only if the control is genuinely absent).
        let start = app.buttons["session.startButton"]
        XCTAssertTrue(start.waitForExistence(timeout: 20), "Start control never appeared")
        start.tap()

        // 02 — live transcript building. Give audio time to feed in.
        _ = app.otherElements["session.transcript"].waitForExistence(timeout: 10)
        sleep(6)
        snapshot(app, "02-live-transcript")

        // 03 — a listener reply landed inline (never asserted; capture regardless).
        _ = app.staticTexts["session.listenerReply"].firstMatch.waitForExistence(timeout: 30)
        snapshot(app, "03-listener-reply")

        // 04 — the SUGGESTED hint line.
        _ = app.otherElements["session.hint"].waitForExistence(timeout: 5)
        snapshot(app, "04-hint-line")

        // Let the session (and video) dwell a little longer, then end cleanly.
        sleep(4)
        if app.buttons["session.startButton"].exists {
            app.buttons["session.startButton"].tap()
        }
        snapshot(app, "05-ended")
    }

    /// Attach a full-screen screenshot kept in the result bundle for xcparse.
    private func snapshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
```

- [ ] **Step 2: Add the file to the UITest target (Mac/Xcode)**

If it isn't already a member (via the synchronized `UITests` folder from Task 9), select `CaptureUITests.swift` in Xcode → File Inspector → check **Target Membership: ShutUpAndListenUITests** only (not the app target).

- [ ] **Step 3: Commit**

```bash
git add ios/UITests/CaptureUITests.swift
git commit -m "feat(ios): CaptureUITests taps Start and snapshots session checkpoints"
```

---

## Task 11: The pipeline script — `capture-demo.sh` (Phase 1 done-gate)

**Files:**
- Create: `ios/scripts/capture-demo.sh`

This is the source of truth: one script both a developer Mac and the GitHub runner invoke. **Phase 1 is done when running it on a Mac yields `ios/build/artifacts/demo.mov` plus light/dark screenshots of real screens.**

- [ ] **Step 1: Write the script**

Create `ios/scripts/capture-demo.sh`:

```bash
#!/usr/bin/env bash
# capture-demo.sh — the single source of truth for the iOS visual-capture
# pipeline. Runs identically on a developer Mac and the GitHub macOS runner.
#
#   1. build-for-testing (shared scheme)
#   2. boot iPhone 16 Pro simulator
#   3. host default input = BlackHole (best effort)
#   4. per appearance (light, then dark): record video (light only), run the
#      UITest, and feed fixtures/demo-conversation.wav into the host mic while
#      it dwells
#   5. extract screenshots from the .xcresult with xcparse into build/artifacts
#
# Artifacts are always collected (even on failure) via an EXIT trap. Only a
# genuine build failure fails the job.
set -euo pipefail

# ── config (overridable via env) ──
SCHEME="ShutUpAndListen"
SIM_NAME="${CAPTURE_SIM:-iPhone 16 Pro}"
BLACKHOLE_DEVICE="${CAPTURE_AUDIO_DEVICE:-BlackHole 2ch}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # ios/
PROJECT="$ROOT/ShutUpAndListen.xcodeproj"
FIXTURE_WAV="$ROOT/fixtures/demo-conversation.wav"
DERIVED="$ROOT/build/DerivedData"
ARTIFACTS="$ROOT/build/artifacts"
RESULTS="$ROOT/build/results"

rm -rf "$ARTIFACTS" "$RESULTS"
mkdir -p "$ARTIFACTS" "$RESULTS"

log() { printf '\n=== %s ===\n' "$*"; }

VIDEO_PID=""
collect_artifacts() {
  for mode in light dark; do
    local rb="$RESULTS/$mode.xcresult"
    [[ -d "$rb" ]] || continue
    mkdir -p "$ARTIFACTS/$mode"
    if command -v xcparse >/dev/null 2>&1; then
      xcparse screenshots "$rb" "$ARTIFACTS/$mode" 2>/dev/null || true
    fi
  done
}
cleanup() {
  [[ -n "$VIDEO_PID" ]] && kill -INT "$VIDEO_PID" 2>/dev/null || true
  collect_artifacts || true
}
trap cleanup EXIT

# ── 1. build-for-testing ──
log "build-for-testing"
xcodebuild build-for-testing \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination "platform=iOS Simulator,name=$SIM_NAME" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO

# ── 2. boot the simulator ──
log "boot $SIM_NAME"
UDID="$(xcrun simctl list devices available | grep -m1 "$SIM_NAME (" | grep -oiE '[0-9a-f-]{36}' || true)"
if [[ -z "${UDID:-}" ]]; then
  UDID="$(xcrun simctl create "$SIM_NAME" "$SIM_NAME")"
fi
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b

# Pre-grant privacy so the app's permission requests return granted without a
# blocking TCC dialog — otherwise the session never goes live and the running
# checkpoints (transcript/hint/reply) never render on a fresh CI simulator.
BUNDLE_ID="${CAPTURE_BUNDLE_ID:-sh.shutupandlisten.ios}"
xcrun simctl privacy "$UDID" grant all "$BUNDLE_ID" >/dev/null 2>&1 || true

# ── 3. host audio input = BlackHole (best effort) ──
if command -v SwitchAudioSource >/dev/null 2>&1; then
  log "set host input = $BLACKHOLE_DEVICE"
  SwitchAudioSource -t input -s "$BLACKHOLE_DEVICE" || true
fi

run_pass() {                      # $1 = light|dark
  local mode="$1"
  local rb="$RESULTS/$mode.xcresult"
  log "capture pass: $mode"
  xcrun simctl ui "$UDID" appearance "$mode"

  if [[ "$mode" == "light" ]]; then
    xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$ARTIFACTS/demo.mov" &
    VIDEO_PID=$!
  fi

  # Run the UITest in the background so we can feed audio while it dwells.
  ( xcodebuild test-without-building \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$DERIVED" \
      -resultBundlePath "$rb" \
      -only-testing:ShutUpAndListenUITests/CaptureUITests/testCaptureSession \
      CODE_SIGNING_ALLOWED=NO ) &
  local test_pid=$!

  # Give the app time to launch + tap Start, then feed the fixture audio.
  sleep 6
  if [[ -f "$FIXTURE_WAV" ]] && command -v afplay >/dev/null 2>&1; then
    afplay "$FIXTURE_WAV" || true
  fi
  wait "$test_pid" || true

  if [[ "$mode" == "light" && -n "$VIDEO_PID" ]]; then
    kill -INT "$VIDEO_PID" 2>/dev/null || true
    wait "$VIDEO_PID" 2>/dev/null || true
    VIDEO_PID=""
  fi
}

run_pass light
run_pass dark

log "done — artifacts in $ARTIFACTS"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x ios/scripts/capture-demo.sh`
Expected: no output.

- [ ] **Step 3: Run the full pipeline (on a Mac) — the Phase-1 done-gate**

Prerequisites on the Mac (one-time):
```bash
brew install blackhole-2ch switchaudio-osx
brew install chargepoint/xcparse/xcparse
./ios/scripts/make-fixture-audio.sh   # produces ios/fixtures/demo-conversation.wav
```

Then run: `./ios/scripts/capture-demo.sh`
Expected:
- `build-for-testing` succeeds (this doubles as an App-target compile gate — the seams and identifiers must build).
- `ios/build/artifacts/demo.mov` exists and plays.
- `ios/build/artifacts/light/` and `ios/build/artifacts/dark/` each contain PNG screenshots named `01-idle` … `05-ended`.
- On the first LOCAL run, `simctl privacy grant all` reliably covers microphone, but the speech-recognition permission prompt may still appear once for a brand-new simulator — tap Allow if it does. Subsequent runs on the same simulator are already granted and the prompt will not reappear.

If host mic injection produced empty transcripts, re-run with the fallback to confirm the transcript/hint checkpoints still render:
`CAPTURE_SEED_TRANSCRIPT=1 ./ios/scripts/capture-demo.sh`

- [ ] **Step 4: Commit the script and the generated fixture `.wav`**

```bash
git add ios/scripts/capture-demo.sh ios/fixtures/demo-conversation.wav
git commit -m "feat(ios): capture-demo.sh drives the session and captures light/dark shots + video"
```

---

## Task 12: Phase 2 — on-demand GitHub workflow

**Files:**
- Create: `.github/workflows/ios-visual.yml`

Only after Phase 1 works on a Mac. Triggers on `workflow_dispatch` only (macOS minutes bill at 10×). Uses `if: always()` on upload so artifacts survive a flaky audio step; only a build failure fails the job. Host mic injection may not work on the runner image, so CI enables the in-app replay fallback (`CAPTURE_SEED_TRANSCRIPT=1`) — the same script, one env var.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ios-visual.yml`:

```yaml
name: iOS Visual Capture

on:
  workflow_dispatch:

jobs:
  capture:
    runs-on: macos-14
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Select Xcode 16
        run: sudo xcode-select -s /Applications/Xcode_16.app

      - name: Install capture tools
        run: |
          brew install blackhole-2ch switchaudio-osx || true
          brew install chargepoint/xcparse/xcparse || true

      - name: Cache SwiftPM
        uses: actions/cache@v4
        with:
          path: ios/build/DerivedData/SourcePackages
          key: spm-${{ hashFiles('ios/ShutUpAndListenKit/Package.swift') }}

      - name: Capture demo
        env:
          # The runner's audio HAL is unreliable for simulator mic injection;
          # use the in-app transcript replay so the checkpoints still render.
          CAPTURE_SEED_TRANSCRIPT: "1"
        run: ./ios/scripts/capture-demo.sh

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ios-visual-artifacts
          path: ios/build/artifacts/**
          if-no-files-found: warn
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ios-visual.yml')); print('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ios-visual.yml
git commit -m "ci(ios): on-demand ios-visual workflow runs capture-demo.sh and uploads artifacts"
```

- [ ] **Step 4: Verify with a manual dispatch (after merge / on a pushed branch)**

Push the branch, then run: `gh workflow run ios-visual.yml --ref <branch>` and watch with `gh run watch`.
Expected: the run completes; the `ios-visual-artifacts` bundle contains `demo.mov` and light/dark screenshots. A failed *audio* step must NOT fail the job; only a build failure does.

---

## Self-Review

**Spec coverage:**
- Auth bypass → Task 5 (seeded dev key + `hasOnboarded`).
- Selective network stub replaying a bundled JSON fixture → Tasks 1–5 (Kit host-match/fixture/responder + App URLProtocol + bundled `capture-fixture.json`).
- Accessibility identifiers on start, transcript, ring, hint, listener reply → Task 6.
- Audio injection (BlackHole + afplay, timed) → Task 11 script; generator + `.wav` → Task 8.
- UITest target + shared scheme; launch with `-uiTestCapture`; real Start tap; checkpoint `XCTAttachment`s; appearance toggled per pass; `recordVideo` wrapper → Tasks 9, 10, 11.
- `capture-demo.sh` running the full documented pipeline and extracting screenshots via xcparse → Task 11.
- Reliability: never assert on transcript text; `if: always()` upload; only build failure fails; in-app replay fallback → Tasks 10 (tolerant waits), 7 + 11 + 12 (fallback), 12 (`if: always()`).
- Kit-level `swift test` coverage of the seam logic that can live in the Kit → Tasks 1–3.
- Phase 2 `workflow_dispatch` workflow uploading artifacts → Task 12.

**Deviations from the design (intentional, grounded in current code):**
- The design's "seed a fake signed-in `AccountStore`" is realized as a seeded **developer API key** — the app is talk-first with no login wall, and the dev-key path lands on the live screen with a stub-intercepted backend without needing Sign in with Apple / `APPLE_SIGN_IN`. Same outcome, simpler seam.
- The design's "question card" checkpoint is replaced by the **hint line** + inline **listener reply** — `QuestionCard` was deleted (commit `99ddae0`); the current live screen is hint-line-only.

**Type/name consistency (used identically across tasks):** `CaptureHosts.shouldIntercept(_:)`, `CaptureFixture(listenerReplies:analystCandidates:seedTranscript:)` / `.decode(from:)`, `CaptureResponder.isStructuredRequest(body:)` / `.responseData(fixture:isAnalyst:callIndex:)`, `CaptureSeam.isActive`/`.shouldSeedTranscript`/`.installIfNeeded()`/`.loadFixture()`, `CaptureURLProtocol.fixture`, launch args `-uiTestCapture` / `-captureSeedTranscript`, env `CAPTURE_SEED_TRANSCRIPT`, identifiers `session.startButton`/`session.ring`/`session.transcript`/`session.hint`/`session.listenerReply`, scheme `ShutUpAndListen`, sim `iPhone 16 Pro`.

**Testability boundary (matches spec):** Kit seam logic (Tasks 1–3) is real `swift test` in-container. App/project/script/workflow (Tasks 4–12) build/run only on macOS; their verification is the Task 11 Phase-1 Mac run and the Task 12 manual dispatch.
