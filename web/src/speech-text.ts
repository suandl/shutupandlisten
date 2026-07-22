// The last mile between what the model GENERATED and what the voice SAYS.
//
// Everything the listener produces is spoken aloud, and until su-lou.11 nothing
// stood between `entry.text` and `sp.synthesize(text)`. Two failures rode that
// gap straight into the operator's ears in the 2026-07-22 feel-test:
//
//   1. A ROLEPLAY STAGE DIRECTION was spoken literally. Llama-3.2-1B-Instruct has
//      strong roleplay priors and opened its reply with "*pauses, letting the
//      thought hang in the air*" — which the TTS dutifully read out as words.
//      prompts/chatgpt.md now forbids emotes, but a prompt is a request, not a
//      guarantee; this module is the guarantee. Belt and braces.
//   2. A MID-WORD FRAGMENT was spoken. The generation cap (64 new tokens, see
//      response-hierarchy.ts) cut the reply at "*pa" and that went to the voice
//      too. The fix is a clean sentence boundary, NOT a bigger cap: wanting more
//      than 64 tokens is itself the B4 ("rare and brief") failure the usefulness
//      bar rejects, so we speak less, not more.
//
// It also owns the SPLIT used for streaming playback (su-lou.11 fix 4): the loop
// used to await the whole generation, then the whole synthesis, then play — a
// perceived latency that is the SUM of two slow stages. `createSpeechStream`
// turns the reply into complete sentences as they arrive, so the first one can be
// synthesized and played while the rest is still being generated.
//
// Everything here is pure and synchronous — no WebAudio, no worker, no DOM — so
// the node suite covers the whole of it (speech-text.test.ts). The glue that
// actually queues, plays and cancels the audio stays in main.ts.

/**
 * Sentence terminator: `.`, `!`, `?` or `…`, optionally followed by a closing
 * quote/bracket, and only where the NEXT thing is whitespace or the end of the
 * text. The lookahead is what keeps "0.5" and "e.g" from reading as ends, and
 * what makes an ellipsis ("Yes… maybe") terminate once rather than three times.
 *
 * Known and accepted: a sentence-final abbreviation ("...in the U.S. and then")
 * reads as a boundary. In this register — a short spoken reflection — that is
 * rare, and the cost is dropping a trailing clause we were unsure of anyway.
 */
const SENTENCE_END = /[.!?…]+["'”’)\]]?(?=\s|$)/g;

/** Sentences shorter than this are merged into their neighbour before synthesis:
 *  a two-word chunk on its own makes the VITS voice sound clipped and choppy. */
export const MIN_CHUNK_CHARS = 24;

/**
 * Strip everything that is written for the EYE out of text destined for the ear.
 *
 * Removed outright (they are performance, not speech): asterisk-wrapped stage
 * directions (`*pauses*`), square-bracket emotes (`[laughs]`), the small set of
 * parenthesised action verbs a roleplay-prone model reaches for (`(sighs)`), and
 * a DANGLING direction the token cap cut in half (`…but not quite. *pa`).
 *
 * Unwrapped (the words were meant to be said, only the markers were not):
 * `**bold**`, `_italic_`, `` `code` ``, `[label](url)`, headings, blockquotes and
 * list bullets.
 *
 * Pure and idempotent — `sanitizeForSpeech(sanitizeForSpeech(x))` is
 * `sanitizeForSpeech(x)` — so it is safe to re-apply to already-clean text (the
 * streaming path re-sanitizes the whole reply on every partial).
 */
export function sanitizeForSpeech(raw: string): string {
  if (!raw) return '';
  let t = raw;

  // ── Code: fenced blocks are never speech; inline code keeps its words. ──
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/```[\s\S]*$/g, ' '); // a fence the cap cut in half
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/`/g, ' ');

  // ── Links/images: say the label, never the URL. Must run BEFORE the
  //    square-bracket emote rule below, which would otherwise eat the label and
  //    leave the naked "(https://…)" behind. ──
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');

  // ── Line-level markdown furniture. The list-bullet rule runs before the
  //    stage-direction rules so a "* item" line is never mistaken for an emote. ──
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  t = t.replace(/^[ \t]*>[ \t]?/gm, '');
  t = t.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '');
  t = t.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ' '); // horizontal rule

  // ── Emphasis: keep the words, drop the markers. `**` first, so the
  //    single-asterisk stage-direction rule below can't chew a bold span apart. ──
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');

  // ── Stage directions — the su-lou.11 defect. A single-asterisk span in this
  //    register is an emote, not emphasis (emphasis is `**`, handled above), so
  //    the whole span goes. The second rule catches an UNCLOSED one, which is
  //    exactly the shape a mid-generation cut leaves behind ("*pa"). ──
  t = t.replace(/\*[^*\n]*\*/g, ' ');
  t = t.replace(/\*[^*\n]*$/g, ' ');
  t = t.replace(/\*/g, ' ');
  t = t.replace(/\[[^\]\n]*\]/g, ' ');
  // Parenthesised emotes only — a deliberately short list of action verbs, so
  // ordinary parenthetical speech ("(the second one)") is left alone.
  t = t.replace(/\((?:laughs?|laughing|chuckles?|sighs?|pauses?|smiles?|smiling|nods?|shrugs?|beat|silence|thinking|long pause)[^)]*\)/gi, ' ');

  // Italic underscores, after `__bold__` so the greedier pair wins first.
  t = t.replace(/_([^_\n]+)_/g, '$1');

  return tidy(t);
}

/**
 * Collapse the whitespace a removal leaves behind and re-attach punctuation that
 * was stranded by it ("I think *pauses*. Yes." → "I think. Yes."), then drop any
 * orphan punctuation left at the very front ("*nods* — right" → "right").
 */
function tidy(t: string): string {
  return t
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/^[\s,;:!?.…—–-]+/, '')
    .trim();
}

/**
 * The longest prefix of `text` that ends on a sentence boundary, or `''` when
 * there is no complete sentence in it yet.
 *
 * This is the streaming primitive: mid-generation, a complete sentence is the
 * only thing safe to hand to the voice, because everything after the last
 * terminator may still grow.
 */
export function completeSentencePrefix(text: string): string {
  const t = text.trim();
  if (!t) return '';
  let end = -1;
  for (const m of t.matchAll(SENTENCE_END)) end = (m.index ?? 0) + m[0].length;
  return end < 0 ? '' : t.slice(0, end).trim();
}

/**
 * Drop a trailing INCOMPLETE sentence — the "*pa" fix. "A thought. And then a fr"
 * becomes "A thought."
 *
 * When there is no terminator anywhere, the text is returned whole rather than
 * emptied: a brief reply with no full stop ("say more about that") is a complete
 * reply, not a fragment, and swallowing it would leave the companion mute at
 * exactly the moment it decided to speak. We can only tell a fragment from a
 * terse sentence when a boundary elsewhere proves the model was still going.
 */
export function trimToLastSentence(text: string): string {
  return completeSentencePrefix(text) || text.trim();
}

/** Sanitize, then trim: the text as it will actually be said (and shown). */
export function speakableText(raw: string): string {
  return trimToLastSentence(sanitizeForSpeech(raw));
}

/** Split on sentence boundaries, keeping the terminator with its sentence. */
export function splitSentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const out: string[] = [];
  let from = 0;
  for (const m of t.matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    const piece = t.slice(from, end).trim();
    if (piece) out.push(piece);
    from = end;
  }
  const rest = t.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}

/**
 * Split text into the units the speaker synthesizes one at a time. Sentences,
 * except that anything shorter than `minChars` is merged into its neighbour —
 * a lone "Right." is both a wasted round-trip and a clipped-sounding clip.
 *
 * The FIRST chunk is what the listener waits on, so nothing here ever holds a
 * complete sentence back hoping for a longer one: merging only ever happens
 * within the text it is handed.
 */
export function speechChunks(text: string, minChars: number = MIN_CHUNK_CHARS): string[] {
  const sentences = splitSentences(text);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= minChars) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) {
    // A short tail joins the previous chunk rather than becoming a stub clip.
    if (out.length > 0) out[out.length - 1] += ` ${buf}`;
    else out.push(buf);
  }
  return out;
}

/**
 * Turns a reply that arrives in pieces into speech-ready chunks, without ever
 * saying anything twice.
 *
 * `push` is fed the reply generated SO FAR (the whole accumulated text, not a
 * delta) and returns only the chunks that just became complete; `finish` is fed
 * the final text and returns whatever is left, dropping a trailing fragment. A
 * caller with no streaming at all simply calls `finish` — it yields the same
 * chunks the whole reply would have produced.
 */
export interface SpeechStream {
  push(textSoFar: string): string[];
  finish(finalText: string): string[];
  /** The cleaned text handed out so far — what the companion has actually said. */
  readonly spoken: string;
}

export function createSpeechStream(): SpeechStream {
  let emitted = '';
  return {
    push(textSoFar: string): string[] {
      const complete = completeSentencePrefix(sanitizeForSpeech(textSoFar));
      // Sanitizing a growing string is prefix-stable in every shape we produce,
      // but if it ever isn't, saying part of the reply twice is far worse than
      // saying the tail once. Diverged ⇒ emit nothing and keep our word.
      if (!complete.startsWith(emitted)) return [];
      const fresh = complete.slice(emitted.length).trim();
      if (!fresh) return [];
      emitted = complete;
      return speechChunks(fresh);
    },
    finish(finalText: string): string[] {
      const cleaned = speakableText(finalText);
      if (!cleaned.startsWith(emitted)) return [];
      const fresh = cleaned.slice(emitted.length).trim();
      emitted = cleaned;
      return fresh ? speechChunks(fresh) : [];
    },
    get spoken(): string {
      return emitted;
    },
  };
}
