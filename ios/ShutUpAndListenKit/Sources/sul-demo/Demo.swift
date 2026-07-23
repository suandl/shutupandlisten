// sul-demo — a terminal-runnable prototype of the quiet companion's decision
// loop, no microphone or iPhone required.
//
// It replays a scripted thinking-out-loud session (an idea dictated in
// fragments, with realistic pauses) through the EXACT production path the iOS
// app uses: speech events + linguistic-EOU evidence → TurnDetector (the
// spec/turn-state-machine.md reducer) → the escalate-slowly gate → and, for
// the rare substantive tiers, the listener model.
//
// What the timeline demonstrates, in order:
//   · a sub-floor breath pause that is simply waited out (no evaluation)
//   · a pause after a trailing "and" the EOU heuristic reads as incomplete —
//     the asymmetric veto EXTENDS patience and the thinker resumes untouched
//   · a patience window that closes mid-thought, where the gate DECLINES to
//     speak (declining is free: same turn, no interruption)
//   · a short finished aside answered by a rules-only backchannel (no model)
//   · the idea landing, and the listener pulling exactly one anchored thread
//
// Usage:
//   swift run sul-demo               # instant replay, canned listener replies
//   swift run sul-demo --realtime    # paced replay (feel the silences)
//   ANTHROPIC_API_KEY=… swift run sul-demo --live   # real Claude replies
//
// Times are a simulated clock, so the default run is deterministic.

import ClaudeClient
import Foundation
import TurnEngine

// ── the script: one session of thinking out loud ──

struct Utterance {
    let start: Double // ms, session clock
    let end: Double
    let text: String  // cumulative words spoken in this segment
}

// The reading-app idea from prompts/claude.md's cadence example, cut into
// fragments whose pauses exercise every branch of the machine.
let script: [Utterance] = [
    // turn 1 — the idea, laid out across four fragments
    .init(start: 0, end: 3200,
          text: "Okay so the idea is a reading app that doesn't show you progress"),
    // 900 ms breath — SUB-FLOOR, preserved (deadline would be 5200)
    .init(start: 4100, end: 9600,
          text: "every reading app I've used turns a book into a task, forty-seven percent done, twelve minutes left in this chapter, and"),
    // 3.4 s pause after a trailing "and" — the veto EXTENDS the floor to 15600
    // and the thinker resumes at 13000, untouched
    .init(start: 13000, end: 17800,
          text: "I've noticed I start reading to move the number instead of reading to actually read,"),
    // 6.8 s pause after a comma: even the EXTENDED window (23800) closes —
    // the machine asks, the gate reads P(complete)=0.05 and DECLINES. Same
    // turn continues at 24600: declining cost nothing (§4b).
    .init(start: 24_600, end: 29_400,
          text: "so this one just hides all of it. No percentage, no time left, no streak. Maybe at the very end it tells you you finished. That's the whole thing."),
    // idea lands (31400) → evaluate → substantive, finished → the model is called

    // turn 2 — a short finished aside → rules-only acknowledgment
    .init(start: 39_000, end: 40_400, text: "Hang on. Let me think."),

    // turn 3 — development, second substantive thought → an EARNED question
    .init(start: 45_000, end: 52_000,
          text: "Yeah okay, the streak is the hook and I'm removing the hook. So the thing that pulls you back has to be the book itself, which means the whole job of the app shifts to how you pick what to read next. That's the real product."),
]

let sessionEnd: Double = 64_000

// ── canned listener (used unless --live) ──

let cannedReplies: [Tier: [String]] = [
    .reflection: [
        "The number was doing the motivating, and you're betting the book can take over that job.",
        "So the shelf, not the streak, becomes the thing that earns the reopen.",
    ],
    .question: [
        "You said you start reading to move the number — with the number gone, what makes someone open the app again tomorrow?",
        "You said picking the next book becomes the whole job — what does that picking actually look like the first time someone opens it?",
    ],
]

// ── plumbing ──

let args = CommandLine.arguments
let realtime = args.contains("--realtime")
let live = args.contains("--live")
let apiKey = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"] ?? ""

func stamp(_ t: Double) -> String {
    String(format: "[%6.2fs]", t / 1000)
}

func say(_ t: Double, _ line: String) {
    print("\(stamp(t)) \(line)")
}

@main
struct Demo {
    static func main() async {
        if live && apiKey.isEmpty {
            print("--live needs ANTHROPIC_API_KEY in the environment; falling back to canned replies.\n")
        }
        let useLive = live && !apiKey.isEmpty
        let client = useLive ? ClaudeClient(config: ClaudeConfig(apiKey: apiKey)) : nil

        print("""
        shutupandlisten — decision-loop demo (\(useLive ? "live Claude" : "canned replies")\(realtime ? ", realtime pacing" : ""))
        knobs: floor 2000ms · incomplete extension 4000ms · threshold 0.5 · EOU heuristic on
        ────────────────────────────────────────────────────────────────────────
        """)

        let knobs = TurnKnobs.defaults
        let detector = TurnDetector(knobs: knobs)

        // Host state, exactly as SessionController keeps it.
        var transcriptByTurn: [Int: String] = [:]
        var decisionsByTurn: [Int: Tier] = [:]
        var lastEouProb: Double = .nan
        var declinedEvaluations = 0
        var replyIndex: [Tier: Int] = [:]
        var history: [ConversationTurn] = []

        func utteranceText(for turn: Int) -> String { transcriptByTurn[turn] ?? "" }

        func nextCanned(_ tier: Tier) -> String {
            let list = cannedReplies[tier] ?? ["…"]
            let i = replyIndex[tier, default: 0]
            replyIndex[tier] = i + 1
            return list[min(i, list.count - 1)]
        }

        func listenerReply(tier: Tier, turn: Int) async -> String {
            let request = buildListenerRequest(
                systemPrompt: ListenerPrompt.systemPrompt,
                tier: tier,
                currentTurnText: utteranceText(for: turn),
                history: history
            )
            if let client {
                do {
                    return try await client.respond(to: request)
                } catch {
                    print("        (live call failed: \(error.localizedDescription) — canned fallback)")
                }
            }
            return nextCanned(tier)
        }

        // Handle the machine's outputs; returns follow-up inputs to feed.
        func handle(_ event: OutputEvent) async -> [InputEvent] {
            switch event {
            case .turnStart(let t, let turn):
                say(t, "── turn \(turn) opens ──")
                return []

            case .evaluate(let t, let turn, let evaluation, let reason, let trigger):
                let text = utteranceText(for: turn)
                let prob = lastEouProb.isFinite ? lastEouProb : completionProb(fromTurnEnd: reason)
                say(t, "⏱ patience window closed (evaluation \(evaluation), \(reason.rawValue), \(trigger.rawValue)) → should the listener speak?")
                let ctx = EvalContext(
                    utteranceIndex: turn,
                    utteranceTextSoFar: text,
                    completionProb: prob,
                    priorDecisions: decisionsByTurn
                        .filter { $0.key < turn }
                        .sorted { $0.key < $1.key }
                        .map { PriorDecision(turn: $0.key, tier: $0.value) }
                )
                let decision = decideTier(ctx, config: GateConfig.derived(from: knobs))
                decisionsByTurn[turn] = decision.tier
                say(t, "   gate: \(decision.reason) → \(decision.tier.rawValue)")

                switch decision.tier {
                case .silence:
                    declinedEvaluations += 1
                    say(t, "   ↳ declined — the thinker was never interrupted (free)")
                    return [.decision(t: t, outcome: .silence)]
                case .acknowledge:
                    let ack = decision.ackText ?? "mm"
                    detector.setKnobs { $0.responseDurationMs = 600 }
                    say(t, "   listener ✧ “\(ack)”  (rules only — no model call)")
                    history.append(.init(speaker: .thinker, text: utteranceText(for: turn)))
                    history.append(.init(speaker: .listener, text: ack))
                    return [.decision(t: t, outcome: .speak)]
                case .reflection, .question:
                    say(t, "   calling the listener model (tier: \(decision.tier.rawValue))…")
                    let reply = await listenerReply(tier: decision.tier, turn: turn)
                    if reply.isEmpty {
                        say(t, "   model chose silence → declined")
                        decisionsByTurn[turn] = .silence
                        return [.decision(t: t, outcome: .silence)]
                    }
                    detector.setKnobs { $0.responseDurationMs = Double(reply.count) * 60 }
                    let marker = decision.tier == .question ? "thread-pull" : "reflection"
                    say(t, "   listener ✦ (\(marker)) “\(reply)”")
                    history.append(.init(speaker: .thinker, text: utteranceText(for: turn)))
                    history.append(.init(speaker: .listener, text: reply))
                    return [.decision(t: t, outcome: .speak)]
                }

            case .turnEnd(let t, let turn, let evaluation, _):
                say(t, "── turn \(turn) ends (the listener takes the floor; evaluation \(evaluation)) ──")
                return []
            case .responseStart:
                return []
            case .responseEnd(let t, _, let reason):
                say(t, "   listener yields the floor (\(reason.rawValue))")
                return []
            case .bargeIn(let t, let turn):
                say(t, "⚡ barge-in on turn \(turn) — response cut instantly")
                return []
            }
        }

        func feed(_ input: InputEvent) async {
            var queue = [input]
            while !queue.isEmpty {
                let next = queue.removeFirst()
                for out in detector.input(next) {
                    queue.append(contentsOf: await handle(out))
                }
            }
        }

        // ── replay ──

        // The iOS host runs a 100 ms tick timer; the replay does the same on a
        // simulated clock so deadlines fire (and decisions get stamped) at
        // their real times, not when the next scripted event happens to land.
        var clock: Double = 0
        func advance(to t: Double) async {
            while clock < t {
                let step = min(clock + 100, t)
                if realtime {
                    try? await Task.sleep(nanoseconds: UInt64((step - clock) * 1_000_000))
                }
                clock = step
                await feed(.tick(t: clock))
            }
        }

        for utterance in script {
            await advance(to: utterance.start)
            await feed(.speechStart(t: utterance.start))
            let turn = detector.currentTurn
            say(utterance.start, "thinker ▶ “\(utterance.text)”")
            await advance(to: utterance.end)
            let existing = transcriptByTurn[turn] ?? ""
            transcriptByTurn[turn] = existing.isEmpty ? utterance.text : existing + " " + utterance.text
            await feed(.speechEnd(t: utterance.end))
            // The EOU heuristic scores the WHOLE utterance so far — same as iOS.
            let prob = LinguisticEOU.completionProbability(for: transcriptByTurn[turn] ?? "")
            lastEouProb = prob
            say(utterance.end, "        ⏸ pause  (EOU heuristic: P(complete) = \(String(format: "%.2f", prob)))")
            await feed(.eou(t: utterance.end, verdict: nil, completionProb: prob))
        }
        await advance(to: sessionEnd)
        await feed(.tick(t: sessionEnd))

        print("""
        ────────────────────────────────────────────────────────────────────────
        \(stamp(sessionEnd)) session ends — \(detector.currentTurn) thoughts, \
        \(decisionsByTurn.values.filter { $0 == .question }.count) thread-pull, \
        \(declinedEvaluations) declined evaluation(s)
        """)
    }
}
