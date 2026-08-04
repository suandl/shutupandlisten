// Server-side copy of the ambient-analyst contract. Mirrors
// ios/ShutUpAndListenKit/Sources/TurnEngine/AnalystPrompt.swift — the schema is
// the contract; keep the prompt text, the JSON schema, and (critically) the
// transcript chunking in sync with that file.
//
// THE CHUNKING IS THE CACHE CONTRACT. The analyst reprocesses the WHOLE
// transcript every cycle; that is only affordable because the transcript is
// sent as an APPEND-ONLY sequence of `system` blocks split at FIXED
// 4000-character boundaries, with the prompt-cache breakpoint on the LAST FROZEN
// chunk. Every block before that boundary stays byte-identical from cycle to
// cycle, so each cycle reads them back at ~0.1x and writes at most one
// newly-completed chunk. Get it wrong and it still "works" while paying
// cache-WRITE pricing (1.25x input) on the entire transcript every cycle,
// forever, never earning a read — strictly worse than sending it uncached, and
// invisible to a correctness test. So the client sends only the transcript
// text (the /v1/coverage shape) and the server rebuilds the block sequence,
// because the chunking is deterministic from the text; the client never chooses
// cache_control.

/// The stable analyst role. Kept in sync with Analyst.instructions. The Swift
/// source wraps long sentences with `\` line-continuations indented two spaces
/// past the closing delimiter; those continuation indents are source-formatting
/// artifacts, not content, so the wrapped sentences are joined here with single
/// spaces (the words the model sees are identical).
export const ANALYST_INSTRUCTIONS =
  `You maintain a running understanding of a person dictating an idea out loud, ` +
  `and you keep a short list of ready-to-speak interjections a quiet listener ` +
  `could offer IF a natural pause arrives. You never decide when to speak — you ` +
  `only keep the options fresh.

From the whole transcript so far, propose up to three candidate interjections, ` +
  `best first. Each must be:
* short — a single sentence;
* anchored to something specific the thinker actually said (a concrete claim, ` +
  `mechanism, example, or tension) — never a generic prompt that could follow ` +
  `any idea;
* tagged by register: "reflection" (a brief, momentum-preserving observation ` +
  `that nudges the thought a little further) or "question" (exactly one ` +
  `specific, idea-developing follow-up).

Do idea development, not emotional processing: no advice, coaching, summary, ` +
  `or reframing. If nothing specific is worth offering yet, return an empty list ` +
  `— a cold pool is a valid, correct state.`;

/// The volatile instruction — placed in the final block, AFTER the cache
/// breakpoint, so it never disturbs the frozen chunks ahead of it. Mirrors
/// Analyst.volatileInstruction.
export const ANALYST_VOLATILE_INSTRUCTION =
  "Produce the candidate interjections for the conversation exactly as it stands right now.";

/// Characters per frozen transcript chunk. Fixed and character-counted so a
/// boundary, once crossed, never moves again — that is what makes earlier chunks
/// byte-identical from one cycle to the next. Mirrors Analyst.transcriptChunkSize.
export const ANALYST_TRANSCRIPT_CHUNK_SIZE = 4000;

/// The leading block: the stable role, then the transcript header. Carries the
/// breakpoint itself only while the transcript is shorter than one chunk.
/// Mirrors Analyst.transcriptHeader.
export const ANALYST_TRANSCRIPT_HEADER = ANALYST_INSTRUCTIONS + "\n\nTRANSCRIPT SO FAR:\n";

/** The JSON schema handed to the Messages API's structured outputs
 * (`output_config.format`), guaranteeing `AnalystResult` parses. Mirrors
 * `Analyst.resultSchema`. */
export const ANALYST_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          register: { type: "string", enum: ["reflection", "question"] },
          anchor: { type: "string" },
        },
        required: ["text", "register", "anchor"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

/** One `system` text block. `cache_control` present ⇒ this block ENDS the
 * cacheable prefix (the breakpoint) — exactly one block per request carries it.
 * Structurally a subset of the Anthropic SDK's `TextBlockParam`, so it is
 * assignable wherever the real client expects a system block. */
export interface SystemTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** One analyst-proposed interjection. `register` is the enum the schema pins;
 * `anchor` is the specific phrase it is built on. */
export interface AnalystCandidate {
  text: string;
  register: "reflection" | "question";
  anchor: string;
}

export interface AnalystResult {
  candidates: AnalystCandidate[];
}

/**
 * Build one analyst cycle's `system` field as an append-only block sequence:
 * `[instructions] + [one block per full chunk] + [remainder + volatile]`, with
 * the cache breakpoint on the last full chunk (or on the instructions block when
 * the transcript is shorter than one chunk). Mirrors `Analyst.buildRequest`'s
 * `systemBlocks` construction — this is where the cache contract lives.
 */
export function analystSystemBlocks(transcript: string): SystemTextBlock[] {
  const body = transcript.length === 0 ? "(nothing transcribed yet)" : transcript;

  // Split at FIXED code-point offsets. Fixed offsets are the whole point: a
  // boundary, once crossed, never moves, so every chunk before the last one is
  // byte-identical from cycle to cycle and reads back from the prompt cache
  // instead of being re-written. Code points (not UTF-16 units) so a boundary
  // can never fall inside a surrogate pair and emit a lone surrogate.
  const points = Array.from(body);
  const chunks: string[] = [];
  for (
    let start = 0;
    points.length - start >= ANALYST_TRANSCRIPT_CHUNK_SIZE;
    start += ANALYST_TRANSCRIPT_CHUNK_SIZE
  ) {
    chunks.push(points.slice(start, start + ANALYST_TRANSCRIPT_CHUNK_SIZE).join(""));
  }
  const remainder = points.slice(chunks.length * ANALYST_TRANSCRIPT_CHUNK_SIZE).join("");

  const blocks: SystemTextBlock[] = [textBlock(ANALYST_TRANSCRIPT_HEADER, chunks.length === 0)];
  chunks.forEach((chunk, i) => blocks.push(textBlock(chunk, i === chunks.length - 1)));
  blocks.push(textBlock(remainder + "\n\n" + ANALYST_VOLATILE_INSTRUCTION, false));

  // The Messages API rejects empty text blocks. This builder never emits one
  // (the header and the volatile tail are always non-empty, chunks are full),
  // but drop defensively — matching ClaudeClient.systemField(blocks:).
  return blocks.filter((block) => block.text.length > 0);
}

function textBlock(text: string, cached: boolean): SystemTextBlock {
  return cached
    ? { type: "text", text, cache_control: { type: "ephemeral" } }
    : { type: "text", text };
}

/** Re-validates the model's JSON against the contract before returning it to
 * the client. Returns a clean `AnalystResult` (known fields only) or null. The
 * `register` enum is enforced here too, so a value the schema forbids is
 * rejected rather than passed through. */
export function parseAnalystResult(value: unknown): AnalystResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) return null;
  const candidates: AnalystCandidate[] = [];
  for (const entry of obj.candidates) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const c = entry as Record<string, unknown>;
    if (typeof c.text !== "string") return null;
    if (c.register !== "reflection" && c.register !== "question") return null;
    if (typeof c.anchor !== "string") return null;
    candidates.push({ text: c.text, register: c.register, anchor: c.anchor });
  }
  return { candidates };
}
