// The question moment. When the listener's one earned line lands, it does not
// join a chat log — the screen quiets and the question typesets alone, large,
// in a serif voice, until the thinker taps it away or simply resumes talking
// (at which point the owner minimizes it to a small chip that reopens it).
//
// No speaker labels, no tier jargon — the words are the whole event.

import SwiftUI

struct QuestionCard: View {
    let text: String
    var onDismiss: () -> Void

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.regularMaterial)
                .ignoresSafeArea()
            VStack(spacing: 28) {
                Text(text)
                    .font(.system(.title2, design: .serif))
                    .multilineTextAlignment(.center)
                    .lineSpacing(7)
                    .padding(.horizontal, 36)
                    .foregroundStyle(.primary)
                Text("tap to keep thinking")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onDismiss)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("The listener asked: \(text)")
        .accessibilityHint("Double tap to dismiss and keep thinking.")
        .accessibilityAddTraits(.isButton)
    }
}

/// The minimized question — one quiet capsule that reopens the card. Shown
/// after the thinker resumed speaking over an open question.
struct QuestionChip: View {
    let text: String
    var onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                Image(systemName: "text.quote")
                    .font(.caption2)
                Text(text)
                    .font(.system(.footnote, design: .serif))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.sulAccent)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.sulAccent.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("The listener's question: \(text)")
        .accessibilityHint("Double tap to show it again.")
    }
}
