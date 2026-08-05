# shutupandlisten proxy — API contract v1

The customer-facing replacement for bring-your-own-API-key: the server holds
the Anthropic key, the app holds a per-user session token. The app never sees
the Anthropic key; the server never sees audio or a running transcript — only
the rare substantive-tier requests the response gate escalates (CONCEPTS.md
"reduced role"), and explicit coverage checks.

Base URL: configurable in the app (default `https://api.shutupandlisten.sh`).
All bodies are JSON. All errors use the envelope:

```json
{ "error": { "type": "string", "message": "string" } }
```

`type` ∈ `invalid_request` | `unauthorized` | `quota_exceeded` | `upstream_error` | `internal`.

## Auth

### POST /v1/auth/apple

Exchange a Sign in with Apple identity token for a proxy session token.

Request:
```json
{ "identityToken": "<JWT from ASAuthorizationAppleIDCredential>" }
```

Server verification: signature against Apple's JWKS
(`https://appleid.apple.com/auth/keys`), `iss == "https://appleid.apple.com"`,
`aud == APPLE_BUNDLE_ID`, `exp` in the future. The token's `sub` is the stable
user id.

Response `200`:
```json
{ "sessionToken": "<opaque-to-client JWT>", "userId": "<apple sub>", "expiresAt": "<ISO 8601>" }
```

`401 unauthorized` on a bad/expired identity token. Session tokens are HS256
JWTs signed with `TOKEN_SECRET`, 30-day expiry, claims `{ sub, iat, exp }`.
Clients re-authenticate with Apple when a request returns `401`.

## Authenticated endpoints

All carry `Authorization: Bearer <sessionToken>`. `401 unauthorized` on a
missing/invalid/expired token.

### POST /v1/listener

One substantive-tier listener turn. The client builds the full request (system
prompt + tier instruction + alternating history) with TurnEngine's
`buildListenerRequest`; the server is a metered pass-through with caps.

Request:
```json
{
  "system": "string",
  "messages": [ { "role": "user" | "assistant", "content": "string" } ],
  "maxTokens": 128,
  "tier": "reflection" | "question"
}
```

Server-enforced caps (reject with `400 invalid_request`): `maxTokens` ≤ 1024,
≤ 200 messages, ≤ 200 KB body, `system` ≤ 50 KB, first message role `user`.

Forwards to the Anthropic Messages API, model `claude-opus-4-8`.

Response `200`:
```json
{ "text": "string" }
```

`text` may be empty — the model choosing silence is a valid, expected reply.

### POST /v1/coverage

Request:
```json
{ "transcript": "string", "criteria": ["string", "..."] }
```

Caps: 1–50 criteria, each ≤ 200 chars; transcript ≤ 200 KB. Uses the server's
own copy of the coverage system prompt and the structured-outputs JSON schema
(mirrors `TurnEngine/Coverage.swift` — schema is the contract, keep in sync).

Response `200` — exactly `CoverageResult`:
```json
{
  "topics": [ { "topic": "string", "covered": true, "evidence": "string" } ],
  "nudge": "string"
}
```

### POST /v1/analyst

One ambient-analyst cycle: the whole transcript in, a small ranked pool of
candidate interjections out. The server owns the analyst system prompt and the
structured-outputs JSON schema (mirrors `TurnEngine/AnalystPrompt.swift` — schema
is the contract, keep in sync), so the response body IS an `AnalystResult`.

Request:
```json
{ "transcript": "string" }
```

Cap: transcript ≤ 200 KB. An empty transcript is valid — a cold-start cycle
returns an empty candidate list.

The transcript is re-sent every cycle, so the server lays it out for the prompt
cache: an append-only sequence of `system` blocks split at fixed 4000-character
boundaries, with the cache breakpoint on the last frozen chunk. Blocks before
that boundary stay byte-identical as the transcript grows, so each cycle reads
them back instead of re-writing them. This layout is built **server-side** from
the transcript text (the chunking is deterministic); the client sends only the
transcript and never chooses `cache_control`.

Response `200` — exactly `AnalystResult`:
```json
{
  "candidates": [
    { "text": "string", "register": "reflection", "anchor": "string" }
  ]
}
```

`register` is `"reflection"` | `"question"`. `candidates` may be empty — a cold
pool is a valid, correct state.

### GET /v1/me

Response `200`:
```json
{ "userId": "string", "usage": { "modelCallsToday": 3, "dailyLimit": 200 } }
```

## Metering

One counter per user per UTC day, incremented on each successful `/v1/listener`,
`/v1/coverage`, and `/v1/analyst` call. At the limit (`DAILY_MODEL_CALL_LIMIT`,
default 200): `429 quota_exceeded`. Not a pricing mechanism — an abuse cap;
pricing comes later.

## Upstream failures

Anthropic 4xx/5xx/refusal → `502 upstream_error` with a safe message (never
the upstream body verbatim; log it server-side). A refusal maps to
`upstream_error` with message "the model declined this request".

## Environment

| Var | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | the one real key, server-side only |
| `APPLE_BUNDLE_ID` | SIWA audience (default `sh.shutupandlisten.ios`) |
| `TOKEN_SECRET` | HS256 signing secret for session tokens |
| `PORT` | listen port (default 8787) |
| `DAILY_MODEL_CALL_LIMIT` | per-user daily cap (default 200) |
| `DATA_DIR` | where the user/metering store persists (default `./data`) |
