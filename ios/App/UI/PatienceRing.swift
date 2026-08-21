// The hero of the live screen: one breathing ring. Silence is the product,
// and this is silence's one visual — faint when idle, subtly alive while the
// thinker talks, slowly filling clockwise while a pause is being waited out,
// dissolving back (never snapping) when speech resumes, and shimmering softly
// while the listener deliberates. No dots, no meters, no color taxonomy.
//
// Motion breathes on a ~4 s cycle. Reduce Motion gets a static ring with a
// static fill — the information survives, the choreography steps aside.

import SwiftUI

struct PatienceRing: View {
    enum Phase: Equatable {
        /// No session — a faint resting ring.
        case idle
        /// Session live, room quiet — gentle breath.
        case listening
        /// The thinker is talking — the ring is alive, subtly level-responsive.
        case thinkerSpeaking
        /// A pause is being timed — the fill arc is the patience window.
        case waiting
        /// The gate escalated; the model is deliberating — a soft shimmer.
        case deciding
        /// The listener is speaking — the ring quiets and dims.
        case replying
    }

    var phase: Phase
    /// 0…1 patience fill. The OWNER animates this (linear 0.1 s ticks while
    /// filling, a slow ease back to 0 when speech resumes) — the ring only
    /// draws it.
    var fill: Double
    /// Mic input level in dB (≈ −70…−10); feeds the speaking glow.
    var levelDb: Float

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One breath, in seconds. Slow on purpose.
    private let breathPeriod: Double = 4
    /// One lap of the deciding shimmer, in seconds.
    private let shimmerPeriod: Double = 7

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: motionPaused)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                // Level-responsive glow: a soft interior bloom that tracks the
                // mic while the room is live. It follows the published input
                // level (each update re-renders this view), so it reads as one
                // smooth, breathing response to your voice rather than the old
                // fixed-rate shimmer — subtly alive, never busy.
                if phase == .listening || phase == .thinkerSpeaking {
                    Circle()
                        .fill(Color.sulAccent.opacity(0.04 + 0.16 * Double(levelNorm)))
                        .padding(24)
                        .blur(radius: 18)
                }

                // The base ring.
                Circle()
                    .stroke(Color.primary.opacity(trackOpacity), lineWidth: 3)

                // The patience window filling, clockwise from 12 o'clock.
                Circle()
                    .trim(from: 0, to: fill)
                    .stroke(
                        Color.sulAccent,
                        style: StrokeStyle(lineWidth: 3, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))

                // Deciding: a soft highlight drifting around the ring — a
                // shimmer, not a color change.
                if phase == .deciding {
                    Circle()
                        .stroke(
                            AngularGradient(
                                gradient: Gradient(colors: [
                                    .clear,
                                    Color.sulAccent.opacity(reduceMotion ? 0.35 : 0.55),
                                    .clear,
                                ]),
                                center: .center
                            ),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round)
                        )
                        .rotationEffect(.degrees(shimmerAngle(at: t)))
                        .transition(.opacity)
                }
            }
            .scaleEffect(ringScale(at: t))
        }
        .opacity(phase == .replying ? 0.4 : (phase == .idle ? 0.7 : 1))
        // Smooth the level follow so the glow/scale glide with your voice
        // instead of stepping with each buffer.
        .animation(.easeOut(duration: 0.18), value: levelNorm)
        .animation(.easeInOut(duration: 2), value: phase)
        .accessibilityElement()
        .accessibilityLabel("Listener")
        .accessibilityValue(accessibilityDescription)
    }

    // ── motion ──

    // Motion only exists while a pause is being timed (`waiting`) or the model
    // is deliberating (`deciding`). Every other phase — including the thinker
    // talking — is static: no perpetual breathing, no idle shimmer (spec §3).
    private var motionPaused: Bool {
        reduceMotion || !(phase == .waiting || phase == .deciding)
    }

    /// The ring's overall scale: the timed-pause breath, multiplied by a subtle
    /// mic-level lean while the room is live. The two compose so a pause still
    /// breathes even if you're mid-word.
    private func ringScale(at t: Double) -> Double {
        breathScale(at: t) * levelScale
    }

    private func breathScale(at t: Double) -> Double {
        guard !reduceMotion else { return 1 }
        // Only the timed-pause state breathes — a single calm cue that the
        // machine is waiting on purpose.
        let amplitude: Double = (phase == .waiting) ? 0.010 : 0
        return 1 + amplitude * sin(t * 2 * .pi / breathPeriod)
    }

    /// A subtle scale that follows the mic while the room is live — the ring
    /// "leans in" a touch as you speak, making listening feel responsive
    /// instead of inert. Off in Reduce Motion.
    private var levelScale: Double {
        guard !reduceMotion, phase == .listening || phase == .thinkerSpeaking else { return 1 }
        return 1 + 0.02 * Double(levelNorm)
    }

    private func shimmerAngle(at t: Double) -> Double {
        guard !reduceMotion else { return 0 }
        return t.truncatingRemainder(dividingBy: shimmerPeriod) / shimmerPeriod * 360
    }

    // ── appearance ──

    private var trackOpacity: Double {
        switch phase {
        case .idle: return 0.10
        default: return 0.16
        }
    }

    /// Mic level normalized 0…1 for the speaking glow.
    private var levelNorm: Float {
        max(0, min(1, (levelDb + 60) / 50))
    }

    // ── accessibility ──

    private var accessibilityDescription: String {
        switch phase {
        case .idle:
            return "Ready. Not listening yet."
        case .listening:
            return "Listening."
        case .thinkerSpeaking:
            return "You're talking. Staying out of the way."
        case .waiting:
            return "Waiting through your pause — "
                + "\(Int((fill * 100).rounded())) percent of the patience window."
        case .deciding:
            return "Your thought may have landed. Deciding quietly."
        case .replying:
            return "The listener is speaking."
        }
    }
}
