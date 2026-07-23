import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COVERAGE_SCHEMA,
  COVERAGE_SYSTEM_PROMPT,
  coverageUserMessage,
  parseCoverageResult,
} from "./coverage-contract.ts";

test("system prompt matches the Coverage.swift contract", () => {
  assert.ok(COVERAGE_SYSTEM_PROMPT.startsWith("You are a completeness checker"));
  assert.ok(COVERAGE_SYSTEM_PROMPT.endsWith("the nudge is an empty string."));
  // Swift's line-continuation string is a single line — no embedded newlines.
  assert.ok(!COVERAGE_SYSTEM_PROMPT.includes("\n"));
});

test("schema mirrors CoverageResult", () => {
  assert.deepEqual(COVERAGE_SCHEMA.required, ["topics", "nudge"]);
  assert.equal(COVERAGE_SCHEMA.additionalProperties, false);
  const item = COVERAGE_SCHEMA.properties.topics.items;
  assert.deepEqual(item.required, ["topic", "covered", "evidence"]);
  assert.equal(item.additionalProperties, false);
});

test("coverageUserMessage formats like Coverage.userMessage", () => {
  assert.equal(
    coverageUserMessage("I talked about pricing.", ["pricing", "the team"]),
    "CHECKLIST:\n- pricing\n- the team\n\nTRANSCRIPT SO FAR:\nI talked about pricing.",
  );
  assert.equal(
    coverageUserMessage("", ["pricing"]),
    "CHECKLIST:\n- pricing\n\nTRANSCRIPT SO FAR:\n(nothing transcribed yet)",
  );
});

test("parseCoverageResult accepts a valid result and strips nothing needed", () => {
  const value = {
    topics: [{ topic: "pricing", covered: true, evidence: "we charge $5" }],
    nudge: "",
  };
  assert.deepEqual(parseCoverageResult(value), value);
});

test("parseCoverageResult rejects malformed results", () => {
  assert.equal(parseCoverageResult(null), null);
  assert.equal(parseCoverageResult([]), null);
  assert.equal(parseCoverageResult({ topics: [], nudge: 3 }), null);
  assert.equal(parseCoverageResult({ topics: "no", nudge: "" }), null);
  assert.equal(
    parseCoverageResult({ topics: [{ topic: "a", covered: "yes", evidence: "" }], nudge: "" }),
    null,
  );
  assert.equal(
    parseCoverageResult({ topics: [{ topic: "a", covered: true }], nudge: "" }),
    null,
  );
});
