import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "./store.ts";
import type { AnthropicLike, AnthropicMessageLike, ServerDeps } from "./server.ts";
import { MODEL, createServer } from "./server.ts";
import type { SystemTextBlock } from "./analyst-contract.ts";
import {
  ANALYST_TRANSCRIPT_CHUNK_SIZE,
  ANALYST_VOLATILE_INSTRUCTION,
} from "./analyst-contract.ts";

// ---------------------------------------------------------------- harness

type CreateParams = Parameters<AnthropicLike["messages"]["create"]>[0];

interface FakeAnthropic extends AnthropicLike {
  calls: CreateParams[];
  respond: (params: CreateParams) => Promise<AnthropicMessageLike>;
}

function textResponse(text: string): AnthropicMessageLike {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

function makeFakeAnthropic(
  respond: (params: CreateParams) => Promise<AnthropicMessageLike> = async () =>
    textResponse("mm."),
): FakeAnthropic {
  const fake: FakeAnthropic = {
    calls: [],
    respond,
    messages: {
      async create(params: CreateParams) {
        fake.calls.push(params);
        return fake.respond(params);
      },
    },
  };
  return fake;
}

interface Harness {
  baseUrl: string;
  anthropic: FakeAnthropic;
  setNow: (date: Date) => void;
  sessionTokenFor: (identityToken: string) => Promise<string>;
  fetchJson: (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; body: any }>;
  authedPost: (path: string, token: string, body: unknown) => Promise<{ status: number; body: any }>;
}

const START = new Date("2026-07-23T12:00:00Z");

async function startServer(
  t: { after: (fn: () => unknown) => void },
  overrides: Partial<Pick<ServerDeps, "store">> & { dailyLimit?: number; anthropic?: FakeAnthropic } = {},
): Promise<Harness> {
  let now = START;
  const anthropic = overrides.anthropic ?? makeFakeAnthropic();
  const server = createServer({
    anthropic,
    // Fake Apple verifier: accepts tokens of the form "apple:<sub>".
    verifyAppleToken: async (identityToken) => {
      if (!identityToken.startsWith("apple:")) throw new Error("bad identity token");
      return { sub: identityToken.slice("apple:".length) };
    },
    store: overrides.store ?? new MemoryStore(),
    clock: () => now,
    config: { tokenSecret: "test-secret", dailyLimit: overrides.dailyLimit ?? 200 },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const fetchJson = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(baseUrl + path, init);
    return { status: res.status, body: await res.json() };
  };
  return {
    baseUrl,
    anthropic,
    setNow: (date) => {
      now = date;
    },
    fetchJson,
    sessionTokenFor: async (identityToken) => {
      const { status, body } = await fetchJson("/v1/auth/apple", {
        method: "POST",
        body: JSON.stringify({ identityToken }),
      });
      assert.equal(status, 200);
      return body.sessionToken as string;
    },
    authedPost: (path, token, body) =>
      fetchJson(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
  };
}

function listenerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    system: "You are a quiet thought companion.",
    messages: [{ role: "user", content: "I keep circling the pricing question." }],
    maxTokens: 128,
    tier: "reflection",
    ...overrides,
  };
}

function assertErrorEnvelope(body: any, type: string): void {
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["message", "type"]);
  assert.equal(body.error.type, type);
  assert.equal(typeof body.error.message, "string");
}

// ---------------------------------------------------------------- auth

test("auth exchange happy path", async (t) => {
  const h = await startServer(t);
  const { status, body } = await h.fetchJson("/v1/auth/apple", {
    method: "POST",
    body: JSON.stringify({ identityToken: "apple:sub-123" }),
  });
  assert.equal(status, 200);
  assert.equal(body.userId, "sub-123");
  assert.equal(typeof body.sessionToken, "string");
  // 30-day expiry, ISO 8601.
  assert.equal(body.expiresAt, new Date(START.getTime() + 30 * 86400 * 1000).toISOString());
  // The issued token authenticates /v1/me.
  const me = await h.fetchJson("/v1/me", {
    headers: { authorization: `Bearer ${body.sessionToken}` },
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.userId, "sub-123");
});

test("auth: bad identity token is 401", async (t) => {
  const h = await startServer(t);
  const { status, body } = await h.fetchJson("/v1/auth/apple", {
    method: "POST",
    body: JSON.stringify({ identityToken: "forged" }),
  });
  assert.equal(status, 401);
  assertErrorEnvelope(body, "unauthorized");
});

test("auth: missing identityToken is 400", async (t) => {
  const h = await startServer(t);
  const { status, body } = await h.fetchJson("/v1/auth/apple", {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(status, 400);
  assertErrorEnvelope(body, "invalid_request");
});

test("401 on missing and malformed bearer tokens", async (t) => {
  const h = await startServer(t);
  for (const headers of [
    undefined,
    { authorization: "Bearer garbage.token.here" },
    { authorization: "Basic abc" },
  ] as const) {
    const { status, body } = await h.fetchJson("/v1/me", headers ? { headers } : {});
    assert.equal(status, 401);
    assertErrorEnvelope(body, "unauthorized");
  }
});

test("401 on expired session token", async (t) => {
  const h = await startServer(t);
  const token = await h.sessionTokenFor("apple:sub-exp");
  // Still valid one day before expiry…
  h.setNow(new Date(START.getTime() + 29 * 86400 * 1000));
  assert.equal(
    (await h.fetchJson("/v1/me", { headers: { authorization: `Bearer ${token}` } })).status,
    200,
  );
  // …expired after 31 days.
  h.setNow(new Date(START.getTime() + 31 * 86400 * 1000));
  const { status, body } = await h.fetchJson("/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(status, 401);
  assertErrorEnvelope(body, "unauthorized");
});

// ---------------------------------------------------------------- listener

test("listener happy path forwards to Anthropic and returns text", async (t) => {
  const h = await startServer(t);
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/listener", token, listenerBody());
  assert.equal(status, 200);
  assert.deepEqual(body, { text: "mm." });
  assert.equal(h.anthropic.calls.length, 1);
  const call = h.anthropic.calls[0]!;
  assert.equal(call.model, MODEL);
  assert.equal(call.max_tokens, 128);
  assert.equal(call.system, "You are a quiet thought companion.");
  assert.deepEqual(call.messages, [
    { role: "user", content: "I keep circling the pricing question." },
  ]);
  assert.equal(call.output_config, undefined);
});

test("listener: empty/missing text block returns empty text (silence is valid)", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => ({ stop_reason: "end_turn", content: [] })),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/listener", token, listenerBody());
  assert.equal(status, 200);
  assert.deepEqual(body, { text: "" });
});

test("listener: refusal maps to 502 upstream_error", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => ({ stop_reason: "refusal", content: [] })),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/listener", token, listenerBody());
  assert.equal(status, 502);
  assertErrorEnvelope(body, "upstream_error");
  assert.equal(body.error.message, "the model declined this request");
});

test("listener: upstream failure maps to 502 with a safe generic message", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => {
      throw new Error("secret internal upstream detail: api key sk-ant-...");
    }),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/listener", token, listenerBody());
  assert.equal(status, 502);
  assertErrorEnvelope(body, "upstream_error");
  assert.ok(!body.error.message.includes("secret"));
  assert.ok(!body.error.message.includes("sk-ant"));
});

test("listener: requires auth", async (t) => {
  const h = await startServer(t);
  const { status, body } = await h.fetchJson("/v1/listener", {
    method: "POST",
    body: JSON.stringify(listenerBody()),
  });
  assert.equal(status, 401);
  assertErrorEnvelope(body, "unauthorized");
});

test("listener: every cap rejects with 400 invalid_request", async (t) => {
  const h = await startServer(t);
  const token = await h.sessionTokenFor("apple:sub-1");
  const cases: Record<string, unknown>[] = [
    listenerBody({ maxTokens: 1025 }),
    listenerBody({ maxTokens: 0 }),
    listenerBody({ maxTokens: "128" }),
    listenerBody({ maxTokens: 12.5 }),
    listenerBody({
      messages: Array.from({ length: 201 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x",
      })),
    }),
    listenerBody({ system: "x".repeat(50 * 1024 + 1) }),
    listenerBody({ messages: [{ role: "assistant", content: "hello" }] }),
    listenerBody({ messages: [] }),
    listenerBody({ messages: "not an array" }),
    listenerBody({ messages: [{ role: "system", content: "x" }] }),
    listenerBody({ messages: [{ role: "user", content: 42 }] }),
    listenerBody({ system: 42 }),
    listenerBody({ tier: "summary" }),
    listenerBody({ tier: undefined }),
  ];
  for (const [i, c] of cases.entries()) {
    const { status, body } = await h.authedPost("/v1/listener", token, c);
    assert.equal(status, 400, `case ${i}: ${JSON.stringify(c).slice(0, 80)}`);
    assertErrorEnvelope(body, "invalid_request");
  }
  // None of the invalid requests reached the upstream or burned quota.
  assert.equal(h.anthropic.calls.length, 0);
  const me = await h.fetchJson("/v1/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.body.usage.modelCallsToday, 0);
});

test("listener: body over 200KB is rejected while reading the stream", async (t) => {
  const h = await startServer(t);
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost(
    "/v1/listener",
    token,
    listenerBody({ messages: [{ role: "user", content: "x".repeat(200 * 1024) }] }),
  );
  assert.equal(status, 400);
  assertErrorEnvelope(body, "invalid_request");
});

test("invalid JSON body is 400", async (t) => {
  const h = await startServer(t);
  const token = await h.sessionTokenFor("apple:sub-1");
  const res = await fetch(`${h.baseUrl}/v1/listener`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assertErrorEnvelope(await res.json(), "invalid_request");
});

// ---------------------------------------------------------------- metering

test("metering increments on success and returns 429 at the limit", async (t) => {
  const h = await startServer(t, { dailyLimit: 2 });
  const token = await h.sessionTokenFor("apple:sub-1");

  assert.equal((await h.authedPost("/v1/listener", token, listenerBody())).status, 200);
  assert.equal((await h.authedPost("/v1/listener", token, listenerBody())).status, 200);

  const me = await h.fetchJson("/v1/me", { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(me.body, {
    userId: "sub-1",
    usage: { modelCallsToday: 2, dailyLimit: 2 },
  });

  const third = await h.authedPost("/v1/listener", token, listenerBody());
  assert.equal(third.status, 429);
  assertErrorEnvelope(third.body, "quota_exceeded");
  // Quota check happens before the upstream call: only 2 upstream calls made.
  assert.equal(h.anthropic.calls.length, 2);

  // A new UTC day resets the counter.
  h.setNow(new Date("2026-07-24T00:00:01Z"));
  assert.equal((await h.authedPost("/v1/listener", token, listenerBody())).status, 200);
});

test("metering: failed upstream calls do not consume quota", async (t) => {
  const h = await startServer(t, {
    dailyLimit: 5,
    anthropic: makeFakeAnthropic(async () => {
      throw new Error("boom");
    }),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  assert.equal((await h.authedPost("/v1/listener", token, listenerBody())).status, 502);
  const me = await h.fetchJson("/v1/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.body.usage.modelCallsToday, 0);
});

test("metering: successful coverage calls also consume quota", async (t) => {
  const h = await startServer(t, {
    dailyLimit: 1,
    anthropic: makeFakeAnthropic(async () =>
      textResponse(JSON.stringify({ topics: [], nudge: "" })),
    ),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const first = await h.authedPost("/v1/coverage", token, {
    transcript: "hello",
    criteria: ["pricing"],
  });
  assert.equal(first.status, 200);
  const me = await h.fetchJson("/v1/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.body.usage.modelCallsToday, 1);
  const second = await h.authedPost("/v1/coverage", token, {
    transcript: "hello",
    criteria: ["pricing"],
  });
  assert.equal(second.status, 429);
});

test("metering is per user", async (t) => {
  const h = await startServer(t, { dailyLimit: 1 });
  const tokenA = await h.sessionTokenFor("apple:sub-a");
  const tokenB = await h.sessionTokenFor("apple:sub-b");
  assert.equal((await h.authedPost("/v1/listener", tokenA, listenerBody())).status, 200);
  assert.equal((await h.authedPost("/v1/listener", tokenA, listenerBody())).status, 429);
  assert.equal((await h.authedPost("/v1/listener", tokenB, listenerBody())).status, 200);
});

// ---------------------------------------------------------------- coverage

const COVERAGE_RESULT = {
  topics: [
    { topic: "pricing", covered: true, evidence: "we charge five dollars a month" },
    { topic: "the ask", covered: false, evidence: "" },
  ],
  nudge: "You haven't said what you're asking for yet.",
};

test("coverage happy path: schema round-trip", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => textResponse(JSON.stringify(COVERAGE_RESULT))),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/coverage", token, {
    transcript: "we charge five dollars a month and the team is just me",
    criteria: ["pricing", "the ask"],
  });
  assert.equal(status, 200);
  assert.deepEqual(body, COVERAGE_RESULT);

  const call = h.anthropic.calls[0]!;
  assert.equal(call.model, MODEL);
  // Coverage sends a plain-string system (analyst is the block-array case).
  assert.equal(typeof call.system, "string");
  assert.ok((call.system as string).startsWith("You are a completeness checker"));
  assert.deepEqual(call.output_config, {
    format: {
      type: "json_schema",
      schema: (await import("./coverage-contract.ts")).COVERAGE_SCHEMA,
    },
  });
  assert.equal(call.messages.length, 1);
  assert.equal(call.messages[0]!.role, "user");
  assert.ok(call.messages[0]!.content.startsWith("CHECKLIST:\n- pricing\n- the ask"));
  assert.ok(call.messages[0]!.content.includes("TRANSCRIPT SO FAR:\nwe charge five dollars"));
});

test("coverage: model output failing re-validation is 502", async (t) => {
  for (const bad of ["not json at all", JSON.stringify({ nudge: "x" })]) {
    const h = await startServer(t, {
      anthropic: makeFakeAnthropic(async () => textResponse(bad)),
    });
    const token = await h.sessionTokenFor("apple:sub-1");
    const { status, body } = await h.authedPost("/v1/coverage", token, {
      transcript: "hello",
      criteria: ["pricing"],
    });
    assert.equal(status, 502);
    assertErrorEnvelope(body, "upstream_error");
  }
});

test("coverage: every cap rejects with 400 invalid_request", async (t) => {
  const h = await startServer(t);
  const token = await h.sessionTokenFor("apple:sub-1");
  const cases: Record<string, unknown>[] = [
    { transcript: "x", criteria: [] },
    { transcript: "x", criteria: Array.from({ length: 51 }, (_, i) => `c${i}`) },
    { transcript: "x", criteria: ["y".repeat(201)] },
    { transcript: "x", criteria: [""] },
    { transcript: "x", criteria: [42] },
    { transcript: "x", criteria: "pricing" },
    { transcript: 42, criteria: ["pricing"] },
    { criteria: ["pricing"] },
    { transcript: "x".repeat(200 * 1024 + 1), criteria: ["pricing"] },
  ];
  for (const [i, c] of cases.entries()) {
    const { status, body } = await h.authedPost("/v1/coverage", token, c);
    assert.equal(status, 400, `case ${i}`);
    assertErrorEnvelope(body, "invalid_request");
  }
  assert.equal(h.anthropic.calls.length, 0);
});

test("coverage: refusal maps to 502 with the contract message", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => ({ stop_reason: "refusal", content: [] })),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/coverage", token, {
    transcript: "hello",
    criteria: ["pricing"],
  });
  assert.equal(status, 502);
  assert.equal(body.error.message, "the model declined this request");
});

// ---------------------------------------------------------------- analyst

const ANALYST_RESULT = {
  candidates: [
    {
      text: "You named two mechanisms — which one is doing the real work?",
      register: "question",
      anchor: "two mechanisms",
    },
    {
      text: "The tension you drew between speed and trust is the actual subject.",
      register: "reflection",
      anchor: "speed and trust",
    },
  ],
};

/** Narrow a recorded call's `system` to the analyst block array. */
function analystSystem(call: CreateParams): SystemTextBlock[] {
  assert.ok(Array.isArray(call.system), "analyst sends a system block array, not a string");
  return call.system as SystemTextBlock[];
}

/** The single cache breakpoint's index — asserts there is exactly one. */
function breakpointIndex(blocks: SystemTextBlock[]): number {
  const idxs = blocks.flatMap((b, i) => (b.cache_control !== undefined ? [i] : []));
  assert.equal(idxs.length, 1, "exactly one cache breakpoint");
  return idxs[0]!;
}

test("analyst happy path: schema round-trip", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => textResponse(JSON.stringify(ANALYST_RESULT))),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/analyst", token, {
    transcript: "I keep circling the pricing question and whether it gates trust.",
  });
  assert.equal(status, 200);
  assert.deepEqual(body, ANALYST_RESULT);

  const call = h.anthropic.calls[0]!;
  assert.equal(call.model, MODEL);
  assert.equal(call.max_tokens, 512);
  assert.deepEqual(call.output_config, {
    format: {
      type: "json_schema",
      schema: (await import("./analyst-contract.ts")).ANALYST_SCHEMA,
    },
  });
  // Exactly one user turn: the volatile "produce candidates now" instruction.
  assert.deepEqual(call.messages, [{ role: "user", content: ANALYST_VOLATILE_INSTRUCTION }]);
  // The system field is the analyst block array; the instructions lead it and a
  // short transcript puts the breakpoint on that first block.
  const blocks = analystSystem(call);
  assert.ok(blocks[0]!.text.startsWith("You maintain a running understanding"));
  assert.equal(breakpointIndex(blocks), 0, "short transcript ⇒ breakpoint on the instructions block");
  assert.equal(blocks.at(-1)!.cache_control, undefined, "the growing tail is never cached");
  assert.ok(blocks.at(-1)!.text.includes(ANALYST_VOLATILE_INSTRUCTION));
});

// THE acceptance bar: prove the prompt cache can actually hit as the transcript
// grows. Two cycles on a growing transcript must emit a byte-identical frozen
// prefix, with the breakpoint on the last frozen chunk — that byte-identity is
// the only thing that lets a cycle read the prefix back instead of re-writing it.
test("analyst: a growing transcript keeps the frozen prefix byte-identical (cache contract)", async (t) => {
  const h = await startServer(t, {
    dailyLimit: 10,
    anthropic: makeFakeAnthropic(async () => textResponse(JSON.stringify({ candidates: [] }))),
  });
  const token = await h.sessionTokenFor("apple:sub-1");

  const CHUNK = ANALYST_TRANSCRIPT_CHUNK_SIZE;
  // Cycle 1: two full chunks + a partial remainder.
  const t1 = "a".repeat(2 * CHUNK + 1500);
  // Cycle 2: the SAME transcript, appended to — enough to complete a third chunk.
  const t2 = t1 + "b".repeat(3000);

  assert.equal((await h.authedPost("/v1/analyst", token, { transcript: t1 })).status, 200);
  assert.equal((await h.authedPost("/v1/analyst", token, { transcript: t2 })).status, 200);

  const sys1 = analystSystem(h.anthropic.calls[0]!);
  const sys2 = analystSystem(h.anthropic.calls[1]!);
  const bp1 = breakpointIndex(sys1);
  const bp2 = breakpointIndex(sys2);

  // Layout is [header, chunk0, chunk1, (chunk2), remainder+volatile]:
  //   cycle 1 → header + 2 chunks + remainder = 4 blocks, breakpoint on index 2
  //   cycle 2 → header + 3 chunks + remainder = 5 blocks, breakpoint on index 3
  assert.equal(sys1.length, 4);
  assert.equal(sys2.length, 5);
  assert.equal(sys2.length, sys1.length + 1, "grew by exactly one frozen chunk");

  // The breakpoint sits on the LAST FROZEN CHUNK — the block just before the
  // uncached remainder — in both cycles.
  assert.equal(bp1, sys1.length - 2);
  assert.equal(bp2, sys2.length - 2);

  // THE CACHE INVARIANT: every block in cycle 1's frozen prefix (header through
  // its breakpoint) is byte-identical in cycle 2.
  for (let i = 0; i <= bp1; i++) {
    assert.equal(sys2[i]!.text, sys1[i]!.text, `frozen block ${i} must be byte-identical`);
  }

  // Each frozen chunk is exactly the chunk size; the remainder is never cached.
  for (let i = 1; i <= bp2; i++) {
    assert.equal(Array.from(sys2[i]!.text).length, CHUNK, `block ${i} is a full chunk`);
  }
  assert.equal(sys2.at(-1)!.cache_control, undefined, "the remainder is never cached");
  assert.ok(sys2.at(-1)!.text.includes(ANALYST_VOLATILE_INSTRUCTION));
});

test("analyst: an empty transcript is a valid cold-start cycle", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => textResponse(JSON.stringify({ candidates: [] }))),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/analyst", token, { transcript: "" });
  assert.equal(status, 200);
  assert.deepEqual(body, { candidates: [] });
  const blocks = analystSystem(h.anthropic.calls[0]!);
  // No frozen chunk yet: instructions block carries the breakpoint, and the
  // placeholder body lives in the uncached tail.
  assert.equal(breakpointIndex(blocks), 0);
  assert.ok(blocks.at(-1)!.text.includes("(nothing transcribed yet)"));
});

test("analyst: model output failing re-validation is 502", async (t) => {
  for (const bad of [
    "not json at all",
    JSON.stringify({ candidates: "nope" }),
    JSON.stringify({ candidates: [{ text: "x", register: "praise", anchor: "y" }] }),
    JSON.stringify({ candidates: [{ text: "x", register: "question" }] }),
  ]) {
    const h = await startServer(t, {
      anthropic: makeFakeAnthropic(async () => textResponse(bad)),
    });
    const token = await h.sessionTokenFor("apple:sub-1");
    const { status, body } = await h.authedPost("/v1/analyst", token, { transcript: "hello" });
    assert.equal(status, 502, `bad payload: ${bad.slice(0, 40)}`);
    assertErrorEnvelope(body, "upstream_error");
  }
});

test("analyst: refusal maps to 502 with the contract message", async (t) => {
  const h = await startServer(t, {
    anthropic: makeFakeAnthropic(async () => ({ stop_reason: "refusal", content: [] })),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const { status, body } = await h.authedPost("/v1/analyst", token, { transcript: "hello" });
  assert.equal(status, 502);
  assert.equal(body.error.message, "the model declined this request");
});

test("analyst: requires auth", async (t) => {
  const h = await startServer(t);
  const { status, body } = await h.fetchJson("/v1/analyst", {
    method: "POST",
    body: JSON.stringify({ transcript: "hello" }),
  });
  assert.equal(status, 401);
  assertErrorEnvelope(body, "unauthorized");
});

test("analyst: invalid transcript rejects with 400 invalid_request", async (t) => {
  const h = await startServer(t);
  const token = await h.sessionTokenFor("apple:sub-1");
  const cases: Record<string, unknown>[] = [
    {}, // missing transcript
    { transcript: 42 }, // non-string
    { transcript: "x".repeat(200 * 1024 + 1) }, // over the 200 KB transcript cap
  ];
  for (const [i, c] of cases.entries()) {
    const { status, body } = await h.authedPost("/v1/analyst", token, c);
    assert.equal(status, 400, `case ${i}`);
    assertErrorEnvelope(body, "invalid_request");
  }
  // None reached the upstream.
  assert.equal(h.anthropic.calls.length, 0);
});

test("metering: successful analyst calls also consume quota", async (t) => {
  const h = await startServer(t, {
    dailyLimit: 1,
    anthropic: makeFakeAnthropic(async () => textResponse(JSON.stringify({ candidates: [] }))),
  });
  const token = await h.sessionTokenFor("apple:sub-1");
  const first = await h.authedPost("/v1/analyst", token, { transcript: "hello" });
  assert.equal(first.status, 200);
  const me = await h.fetchJson("/v1/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.body.usage.modelCallsToday, 1);
  const second = await h.authedPost("/v1/analyst", token, { transcript: "hello" });
  assert.equal(second.status, 429);
  assertErrorEnvelope(second.body, "quota_exceeded");
});

// ---------------------------------------------------------------- misc

test("unknown routes are 404 with the error envelope", async (t) => {
  const h = await startServer(t);
  for (const [path, init] of [
    ["/v1/unknown", {}],
    ["/", {}],
    ["/v1/listener", {}], // GET on a POST route
    ["/v1/me", { method: "POST" }], // POST on a GET route
  ] as const) {
    const { status, body } = await h.fetchJson(path, init);
    assert.equal(status, 404, path);
    assertErrorEnvelope(body, "invalid_request");
  }
});
