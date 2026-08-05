import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYST_INSTRUCTIONS,
  ANALYST_SCHEMA,
  ANALYST_TRANSCRIPT_CHUNK_SIZE,
  ANALYST_TRANSCRIPT_HEADER,
  ANALYST_VOLATILE_INSTRUCTION,
  analystSystemBlocks,
  parseAnalystResult,
  type SystemTextBlock,
} from "./analyst-contract.ts";

const CHUNK = ANALYST_TRANSCRIPT_CHUNK_SIZE;

// Deterministic filler with varied content, so "these blocks are equal" means
// the boundaries lined up — not that every character was the same. `from`
// continues the pattern, so filler(9000) + filler(3000, 9000) === filler(12000).
function filler(n: number, from = 0): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ";
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[(i + from) % alphabet.length];
  return s;
}

function breakpoint(blocks: SystemTextBlock[]): number {
  const idxs = blocks.flatMap((b, i) => (b.cache_control !== undefined ? [i] : []));
  assert.equal(idxs.length, 1);
  return idxs[0]!;
}

test("instructions mirror Analyst.instructions", () => {
  assert.ok(ANALYST_INSTRUCTIONS.startsWith("You maintain a running understanding"));
  assert.ok(ANALYST_INSTRUCTIONS.endsWith("a cold pool is a valid, correct state."));
  // The three bullets and both registers survive the copy.
  assert.ok(ANALYST_INSTRUCTIONS.includes("\n* short — a single sentence;"));
  assert.ok(ANALYST_INSTRUCTIONS.includes('"reflection"'));
  assert.ok(ANALYST_INSTRUCTIONS.includes('"question"'));
  // Header appends the transcript label, like Analyst.transcriptHeader.
  assert.equal(ANALYST_TRANSCRIPT_HEADER, ANALYST_INSTRUCTIONS + "\n\nTRANSCRIPT SO FAR:\n");
});

test("schema mirrors AnalystResult", () => {
  assert.deepEqual(ANALYST_SCHEMA.required, ["candidates"]);
  assert.equal(ANALYST_SCHEMA.additionalProperties, false);
  const item = ANALYST_SCHEMA.properties.candidates.items;
  assert.deepEqual(item.required, ["text", "register", "anchor"]);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.properties.register.enum, ["reflection", "question"]);
});

test("analystSystemBlocks: short transcript ⇒ instructions + uncached tail", () => {
  const blocks = analystSystemBlocks("so the idea is a reading app");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.text, ANALYST_TRANSCRIPT_HEADER);
  assert.equal(breakpoint(blocks), 0, "under one chunk the breakpoint falls on the instructions block");
  assert.ok(blocks[1]!.text.includes("so the idea is a reading app"));
  assert.ok(blocks[1]!.text.endsWith(ANALYST_VOLATILE_INSTRUCTION));
  assert.equal(blocks[1]!.cache_control, undefined, "the growing tail is never cached");
});

test("analystSystemBlocks: empty transcript uses the placeholder body", () => {
  const blocks = analystSystemBlocks("");
  assert.equal(blocks.length, 2);
  assert.equal(breakpoint(blocks), 0);
  assert.ok(blocks[1]!.text.startsWith("(nothing transcribed yet)"));
});

test("analystSystemBlocks: breakpoint sits on the last full chunk", () => {
  // 9000 chars ⇒ two full 4000-char chunks + a 1000-char remainder.
  const blocks = analystSystemBlocks(filler(9000));
  assert.equal(blocks.length, 4, "instructions + 2 chunks + tail");
  assert.equal(Array.from(blocks[1]!.text).length, CHUNK);
  assert.equal(Array.from(blocks[2]!.text).length, CHUNK);
  assert.equal(breakpoint(blocks), 2, "the breakpoint ends the last FROZEN chunk");
  assert.equal(blocks.at(-1)!.cache_control, undefined);
});

test("analystSystemBlocks: exactly one breakpoint at every length", () => {
  for (const n of [0, 100, CHUNK, 9000, 20000]) {
    const blocks = analystSystemBlocks(filler(n));
    assert.equal(
      blocks.filter((b) => b.cache_control !== undefined).length,
      1,
      `exactly one breakpoint at length ${n}`,
    );
  }
});

test("analystSystemBlocks: the volatile instruction sits after the breakpoint", () => {
  const blocks = analystSystemBlocks(filler(9000));
  const cut = breakpoint(blocks);
  assert.ok(blocks.at(-1)!.text.includes(ANALYST_VOLATILE_INSTRUCTION));
  for (let i = 0; i <= cut; i++) {
    assert.ok(
      !blocks[i]!.text.includes(ANALYST_VOLATILE_INSTRUCTION),
      "nothing up to the breakpoint may carry the volatile instruction",
    );
  }
});

test("analystSystemBlocks: a growing transcript leaves earlier chunks byte-identical", () => {
  const shorter = filler(9000); // 2 full chunks + 1000 left over
  const longer = shorter + filler(3000, 9000); // 3 full chunks, nothing left over

  const a = analystSystemBlocks(shorter);
  const b = analystSystemBlocks(longer);

  // Instructions + both already-frozen chunks are unchanged — that prefix is
  // what the next cycle reads back from cache instead of re-writing.
  assert.deepEqual(
    a.slice(0, 3).map((x) => x.text),
    b.slice(0, 3).map((x) => x.text),
  );
  // Only the newly-completed chunk is added, and the breakpoint moves onto it.
  assert.equal(a.length, 4);
  assert.equal(b.length, 5);
  assert.equal(breakpoint(a), 2);
  assert.equal(breakpoint(b), 3);
});

test("analystSystemBlocks: a revised tail does not disturb the frozen chunks", () => {
  // Live partials rewrite only the very end of the transcript.
  const frozen = filler(8000); // exactly two full chunks
  const a = analystSystemBlocks(frozen + "half a sentenc");
  const b = analystSystemBlocks(frozen + "half a sentence, revised");

  assert.deepEqual(
    a.slice(0, 3).map((x) => x.text),
    b.slice(0, 3).map((x) => x.text),
  );
  assert.notEqual(a.at(-1)!.text, b.at(-1)!.text);
});

test("parseAnalystResult accepts a valid result", () => {
  const value = {
    candidates: [
      { text: "What breaks if you drop the second mechanism?", register: "question", anchor: "second mechanism" },
      { text: "The through-line is trust, not speed.", register: "reflection", anchor: "trust" },
    ],
  };
  assert.deepEqual(parseAnalystResult(value), value);
});

test("parseAnalystResult accepts an empty candidate list (a valid cold pool)", () => {
  assert.deepEqual(parseAnalystResult({ candidates: [] }), { candidates: [] });
});

test("parseAnalystResult rejects malformed results", () => {
  assert.equal(parseAnalystResult(null), null);
  assert.equal(parseAnalystResult([]), null);
  assert.equal(parseAnalystResult({}), null); // missing candidates
  assert.equal(parseAnalystResult({ candidates: "no" }), null);
  // missing anchor
  assert.equal(parseAnalystResult({ candidates: [{ text: "x", register: "question" }] }), null);
  // register outside the enum
  assert.equal(parseAnalystResult({ candidates: [{ text: "x", register: "praise", anchor: "y" }] }), null);
  // non-string text
  assert.equal(parseAnalystResult({ candidates: [{ text: 1, register: "question", anchor: "y" }] }), null);
  assert.equal(parseAnalystResult({ candidates: [null] }), null);
});
