// Auth: Sign in with Apple identity-token verification (jose + Apple's JWKS)
// and HS256 proxy session tokens.

import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";

export interface AppleIdentity {
  sub: string;
}

/** Verifies a Sign in with Apple identity token and returns the stable user
 * id (`sub`). Throws on any invalid/expired token. */
export type AppleTokenVerifier = (identityToken: string) => Promise<AppleIdentity>;

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");

/** Real verifier: signature against Apple's JWKS, iss/aud/exp checks. */
export function makeAppleVerifier(bundleId: string): AppleTokenVerifier {
  const jwks = createRemoteJWKSet(APPLE_JWKS_URL);
  return async (identityToken: string): Promise<AppleIdentity> => {
    const { payload } = await jwtVerify(identityToken, jwks, {
      issuer: APPLE_ISSUER,
      audience: bundleId,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("identity token missing sub");
    }
    return { sub: payload.sub };
  };
}

/** Session tokens are HS256 JWTs with claims { sub, iat, exp }, 30-day expiry. */
export const SESSION_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export interface SessionToken {
  token: string;
  expiresAt: Date;
}

export async function issueSessionToken(
  secret: string,
  sub: string,
  now: Date,
): Promise<SessionToken> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SESSION_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey(secret));
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Verifies a session token; returns the user id (`sub`). Throws on
 * invalid/expired tokens. `now` is injectable so tests can fast-forward. */
export async function verifySessionToken(
  secret: string,
  token: string,
  now: Date,
): Promise<string> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ["HS256"],
    currentDate: now,
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("session token missing sub");
  }
  return payload.sub;
}
