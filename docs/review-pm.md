# PM check — shutupandlisten product references

This repo has no `docs/product-goals.md`. Read these for who the product serves
and how a change is judged the right one.

- **`CONCEPTS.md`**, the "Product" section (repo root) — what the product is: a
  voice-mode quiet thought companion that holds back while a person thinks out
  loud, and its response hierarchy (silence, minimal acknowledgment, short
  momentum-preserving reflection, one brief follow-up question). The "Eval
  harness roles" section names the behaviors the companion is scored on
  (restraint, variety, probing-depth, no-summarize).
- **`docs/usefulness-bar.md`** — the acceptance reference: a rubric of named,
  checkable behaviors tiered by weight, derived from the operator's daily use of
  the baseline. It sets the question "useful enough to reach for, flaws and all?",
  which is the outcome a change is judged against.
- **`docs/ios-product-evaluation.md`** — the product diagnosis and roadmap for
  the iOS app: the move from a test-harness presentation toward a product the
  operator reaches for, what changed, what is still a mockup, and what was
  rejected.

Who the product serves: the operator is its user today and the acceptance
reference (`docs/usefulness-bar.md` is derived from their daily use), and the
stated goal (`CONCEPTS.md`) is to deliver it as a standalone product others can
use. When a change alters what the product is for or what it promises the people
it serves, its matching update to these docs belongs in the same PR.
