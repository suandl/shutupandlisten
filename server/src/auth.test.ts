import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt } from "jose";
import {
  SESSION_TOKEN_TTL_SECONDS,
  issueSessionToken,
  verifySessionToken,
} from "./auth.ts";

const SECRET = "test-secret";
const NOW = new Date("2026-07-23T12:00:00Z");

test("session token round-trips and carries sub/iat/exp", async () => {
  const { token, expiresAt } = await issueSessionToken(SECRET, "apple-sub-1", NOW);
  const claims = decodeJwt(token);
  assert.equal(claims.sub, "apple-sub-1");
  assert.equal(claims.iat, Math.floor(NOW.getTime() / 1000));
  assert.equal(claims.exp, claims.iat! + SESSION_TOKEN_TTL_SECONDS);
  assert.equal(expiresAt.getTime(), NOW.getTime() + SESSION_TOKEN_TTL_SECONDS * 1000);
  assert.equal(await verifySessionToken(SECRET, token, NOW), "apple-sub-1");
});

test("session token is rejected after 30 days", async () => {
  const { token } = await issueSessionToken(SECRET, "apple-sub-1", NOW);
  const later = new Date(NOW.getTime() + (SESSION_TOKEN_TTL_SECONDS + 60) * 1000);
  await assert.rejects(verifySessionToken(SECRET, token, later));
});

test("session token signed with a different secret is rejected", async () => {
  const { token } = await issueSessionToken("other-secret", "apple-sub-1", NOW);
  await assert.rejects(verifySessionToken(SECRET, token, NOW));
});

test("garbage token is rejected", async () => {
  await assert.rejects(verifySessionToken(SECRET, "not.a.jwt", NOW));
});
