# shutupandlisten proxy server

The customer-facing replacement for bring-your-own-API-key: this server holds
the one real Anthropic key and hands the iOS app per-user session tokens
instead. Thanks to the pipeline's "reduced role" economics (CONCEPTS.md), most
turns never reach here at all — endpointing and the rules layer handle silence
and acknowledgments on-device, so the server only sees the rare
substantive-tier listener turns the response gate escalates, plus explicit
coverage checks. It verifies Sign in with Apple identity tokens, issues 30-day
HS256 session tokens, enforces the request caps in [API.md](./API.md), meters
model calls per user per UTC day, and passes validated requests through to the
Anthropic Messages API (`claude-opus-4-8`).

The API contract lives in [API.md](./API.md); this implementation follows it
exactly.

## Run

Requires Node 22 (native TypeScript type-stripping — no build step).

```sh
cd server
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and TOKEN_SECRET
npm start              # node src/index.ts, listens on PORT (default 8787)
```

Tests are hermetic (no network, fake Anthropic client and Apple verifier):

```sh
npm test               # node --test
npm run typecheck      # tsc --noEmit
```

## Environment

| Var | Meaning | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | the one real key, server-side only | *(required)* |
| `TOKEN_SECRET` | HS256 signing secret for session tokens | *(required)* |
| `APPLE_BUNDLE_ID` | Sign in with Apple audience | `sh.shutupandlisten.ios` |
| `PORT` | listen port | `8787` |
| `DAILY_MODEL_CALL_LIMIT` | per-user daily model-call cap | `200` |
| `DATA_DIR` | where the metering store persists | `./data` |

## Deploy

Any Node 22+ host works — there is no build step and no framework, just
`node src/index.ts` behind your TLS terminator. The process is stateless
except for `DATA_DIR`, which holds a single JSON usage file (per-user
per-UTC-day counters, written atomically via tmp+rename): give it a persistent
volume if you care about quota continuity across restarts, or don't — losing
it only resets the day's abuse counters. Scale-out beyond one instance would
need a shared store behind the small `Store` interface in `src/store.ts`.

## Layout

| File | What it is |
|---|---|
| `src/index.ts` | entry point — wires real deps from env, listens |
| `src/server.ts` | `createServer(deps)` — routes, caps, error envelope, metering |
| `src/auth.ts` | Apple identity-token verification (jose/JWKS) + session tokens |
| `src/store.ts` | `Store` interface, in-memory impl, JSON-file impl |
| `src/coverage-contract.ts` | server copy of the coverage prompt + JSON schema (mirrors `TurnEngine/Coverage.swift` — keep in sync) |
