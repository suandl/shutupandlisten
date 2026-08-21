// The hero of the live screen: one horizon line. Silence is the product, and
// this is silence's one visual — a hairline that BRIGHTENS rather than fills.
//
// It replaces the patience ring on purpose. A clockwise arc filling toward
// completion is a progress bar bent into a circle: it says time is running
// out, inside a product whose whole thesis is that a pause is *not* a
// deadline. Brightness has no terminus, so it cannot read as a countdown.
// The line runs the full width and dissolves at both ends — it owns no
// endpoint for anything to arrive at.
//
// Three signals, one accent, no taxonomy:
//   • mic level — how brightly the horizon burns, and how far the light
//     spills off it. This is the "am I being heard" answer and the primary
//     signal here: sound being registered is the loudest thing on screen.
//   • patience window — how much WEIGHT the line gathers as a pause is held.
//     Weight and luminance, never extent.
//   • phase — the resting luminance, plus a slow drift while the model
//     deliberates. At most three of the six are ever NAMED in words, which is
//     SessionView's job, not this view's.
//
// Motion only exists while a pause is being timed (`waiting`) or the model is
// deliberating (`deciding`). Reduce Motion gets the same information without
// the choreography — a static line at the same weight and brightness.

import SwiftUI

struct HorizonLine: View {
    enum Phase: Equatable {
        /// No session — a faint resting line.
        case idle
        /// Session live, room quiet — the horizon answers the mic.
        case listening
        /// The thinker is talking — the horizon burns with their voice.
        case thinkerSpeaking
        /// A pause is being timed — the line gathers weight.
        case waiting
        /// The gate escalated; the model is deliberating — a soft drift.
        case deciding
        /// The listener is speaking — the horizon quiets and dims.
        case replying
    }

    var phase: Phase
    /// 0…1 depth into the patience window. The OWNER animates this (linear
    /// 0.1 s ticks while the window runs, a slow ease back to 0 when speech
    /// resumes) — the line only draws it, and draws it as weight, never as an
    /// extent. Deliberately not called `fill`: nothing here fills.
    var patience: Double
    /// Mic input level in dB (≈ −70…−10); the horizon's brightness and spill.
    var levelDb: Float

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One breath, in seconds. Slow on purpose.
    private let breathPeriod: Double = 4
    /// One lap of the deciding drift, in seconds.
    private let driftPeriod: Double = 7

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: motionPaused)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            GeometryReader { geo in
                ZStack {
                    // Level-responsive spill: a soft atmospheric swell above
                    // and below the line, like light sitting on a horizon. It
                    // follows the published input level (each update re-renders
                    // this view), so a voice reads as the light growing rather
                    // than as a meter moving.
                    if phase == .listening || phase == .thinkerSpeaking {
                        spill(width: geo.size.width)
                    }

                    // The resting track: always the full width, always the
                    // same weight. This is the horizon when nothing is
                    // happening.
                    Rectangle()
                        .fill(fade(Color.primary, edge: trackOpacity, middle: trackOpacity))
                        .frame(height: 2)

                    // The lit horizon. Everything the ring said with an arc is
                    // said here with light and weight.
                    Rectangle()
                        .fill(fade(
                            Color.sulAccent,
                            edge: luminance(at: t),
                            middle: middleLuminance(at: t)
                        ))
                        .frame(height: weight)
                        .blur(radius: 0.4)

                    // Deciding: a soft highlight drifting along the line — a
                    // wandering brightness, not a color change and not a
                    // traverse from one end to the other.
                    if phase == .deciding {
                        drift(at: t)
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
            }
        }
        .opacity(phase == .replying ? 0.4 : (phase == .idle ? 0.7 : 1))
        // Smooth the level follow so the light glides with your voice instead
        // of stepping with each buffer.
        .animation(.easeOut(duration: 0.18), value: levelNorm)
        .animation(.easeInOut(duration: 2), value: phase)
        .accessibilityElement()
        .accessibilityLabel("Listener")
        .accessibilityValue(accessibilityDescription)
    }

    // ── the layers ──

    /// Both ends dissolve to nothing. A line with hard ends is a bar, and a
    /// bar has a far end to arrive at — the exact reading being retired here.
    private func fade(_ color: Color, edge: Double, middle: Double) -> LinearGradient {
        LinearGradient(
            stops: [
                Gradient.Stop(color: .clear, location: 0),
                Gradient.Stop(color: color.opacity(edge), location: 0.16),
                Gradient.Stop(color: color.opacity(middle), location: 0.5),
                Gradient.Stop(color: color.opacity(edge), location: 0.84),
                Gradient.Stop(color: .clear, location: 1),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    private func spill(width: CGFloat) -> some View {
        let reach: CGFloat = 30 + 76 * CGFloat(levelNorm)
        return Ellipse()
            .fill(
                RadialGradient(
                    gradient: Gradient(colors: [
                        Color.sulAccent.opacity(0.03 + 0.24 * Double(levelNorm)),
                        .clear,
                    ]),
                    center: .center,
                    startRadius: 0,
                    endRadius: max(1, width * 0.5)
                )
            )
            .frame(width: width, height: reach)
            .blur(radius: 14)
    }

    private func drift(at t: Double) -> some View {
        let c = driftCenter(at: t)
        let halo = Color.sulAccent.opacity(reduceMotion ? 0.35 : 0.55)
        return Rectangle()
            .fill(
                LinearGradient(
                    stops: [
                        Gradient.Stop(color: .clear, location: max(0, c - 0.22)),
                        Gradient.Stop(color: halo, location: c),
                        Gradient.Stop(color: .clear, location: min(1, c + 0.22)),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .frame(height: weight)
            .blur(radius: 1.5)
            .transition(.opacity)
    }

    // ── motion ──

    // Motion only exists while a pause is being timed (`waiting`) or the model
    // is deliberating (`deciding`). Every other phase — including the thinker
    // talking — is static: no perpetual breathing, no idle shimmer (spec §3).
    // The mic response is not motion; it is the signal, and it survives Reduce
    // Motion untouched.
    private var motionPaused: Bool {
        reduceMotion || !(phase == .waiting || phase == .deciding)
    }

    /// The timed-pause breath, as luminance rather than movement — a calm cue
    /// that the machine is waiting on purpose. Nothing travels, nothing grows.
    private func breath(at t: Double) -> Double {
        guard !reduceMotion, phase == .waiting else { return 1 }
        return 1 + 0.06 * sin(t * 2 * .pi / breathPeriod)
    }

    /// Where the deciding highlight currently sits, 0…1 along the line. A slow
    /// sine, so it wanders out and back and never arrives anywhere.
    private func driftCenter(at t: Double) -> CGFloat {
        guard !reduceMotion else { return 0.5 }
        let lap = t.truncatingRemainder(dividingBy: driftPeriod) / driftPeriod
        return 0.5 + 0.3 * CGFloat(sin(lap * 2 * .pi))
    }

    // ── appearance ──

    private var trackOpacity: Double {
        switch phase {
        case .idle: return 0.10
        default: return 0.16
        }
    }

    /// The patience window as WEIGHT: the line thickens as a pause is held,
    /// the way a horizon thickens before dawn. There is no far end it is
    /// growing toward — only more of itself, everywhere at once.
    private var weight: CGFloat {
        let hairline: CGFloat = 2
        switch phase {
        case .waiting: return hairline + 2.4 * CGFloat(patience)
        case .listening, .thinkerSpeaking: return hairline + 0.8 * CGFloat(levelNorm)
        default: return hairline
        }
    }

    /// How brightly the horizon burns.
    private func luminance(at t: Double) -> Double {
        switch phase {
        case .idle:
            return 0
        case .listening, .thinkerSpeaking:
            // The primary expression: a quiet room leaves a dim horizon, a
            // voice lights it up.
            return 0.20 + 0.60 * Double(levelNorm)
        case .waiting:
            // Gathers with the window, but is still climbing when the window
            // resolves — it never reaches a value that means "done".
            return (0.30 + 0.42 * patience) * breath(at: t)
        case .deciding:
            return 0.52
        case .replying:
            return 0.18
        }
    }

    /// While the room is live the middle of the horizon burns hottest, so a
    /// voice reads as a swell in the light rather than as a level meter.
    private func middleLuminance(at t: Double) -> Double {
        let base = luminance(at: t)
        guard phase == .listening || phase == .thinkerSpeaking else { return base }
        return min(1, base * (1 + 0.5 * Double(levelNorm)))
    }

    /// Mic level normalized 0…1.
    private var levelNorm: Float {
        max(0, min(1, (levelDb + 60) / 50))
    }

    // ── accessibility ──

    // The window's depth is spoken the way it is drawn — as gathering, not as
    // a percentage. The old ring read out "N percent of the patience window",
    // which is the countdown semantics this change exists to retire; a number
    // that climbs to 100 is a deadline whether it is seen or heard.
    private var accessibilityDescription: String {
        switch phase {
        case .idle:
            return "Ready. Not listening yet."
        case .listening:
            return "Listening."
        case .thinkerSpeaking:
            return "You're talking. Staying out of the way."
        case .waiting:
            if patience < 0.34 {
                return "Waiting through your pause."
            } else if patience < 0.7 {
                return "Still waiting through your pause."
            } else {
                return "Waiting through a long pause."
            }
        case .deciding:
            return "Your thought may have landed. Deciding quietly."
        case .replying:
            return "The listener is speaking."
        }
    }
}
