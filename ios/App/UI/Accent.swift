// The app's one accent token.
//
// It lives here, on its own, because it outlives whatever is currently
// drawing with it. It used to be declared inside `PatienceRing.swift`, so
// retiring that component would have taken the entire app's accent with it —
// seventeen call sites across the session screen and the session detail have
// nothing to do with the ring. A token that every view depends on does not
// belong inside any one view.
//
// The VALUE is unchanged by that move and is deliberately not settled here:
// the canonical ember (and its light-mode pair) is an open identity question,
// and this file exists so that answering it is a one-line edit in a neutral
// place rather than surgery inside a component.

import SwiftUI

extension Color {
    /// The app's ONE accent — a warm, low-glare amber. Defined in code for
    /// now; migrates to an asset-catalog `AccentColor` in Wave 3a. Every view
    /// that needs the accent should use this, not a SwiftUI primary.
    static let sulAccent = Color(red: 0.91, green: 0.67, blue: 0.36)
}
