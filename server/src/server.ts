// HTTP server implementing server/API.md. Built on node:http only.
//
// createServer(deps) takes injected dependencies (Anthropic-like client, Apple
// token verifier, store, clock, config) so tests run hermetically with fakes.

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppleTokenVerifier } from "./auth.ts";
import { issueSessionToken, verifySessionToken } from "./auth.ts";
import type { Store } from "./store.ts";
import { utcDay } from "./store.ts";
import {
  COVERAGE_SCHEMA,
  COVERAGE_SYSTEM_PROMPT,
  coverageUserMessage,
  parseCoverageResult,
} from "./coverage-contract.ts";

export const MODEL = "claude-opus-4-8";

// Caps from API.md.
const KB = 1024;
const MAX_LISTENER_BODY_BYTES = 200 * KB;
const MAX_SYSTEM_BYTES = 50 * KB;
const MAX_MESSAGES = 200;
const MAX_MAX_TOKENS = 1024;
const MAX_TRANSCRIPT_BYTES = 200 * KB;
const MAX_CRITERIA = 50;
const MAX_CRITERION_CHARS = 200;
const MAX_AUTH_BODY_BYTES = 64 * KB;
// Coverage body cap: transcript cap plus headroom for JSON escaping + criteria.
const MAX_COVERAGE_BODY_BYTES = 280 * KB;
const COVERAGE_MAX_TOKENS = 2048;

export type ErrorType =
  | "invalid_request"
  | "unauthorized"
  | "quota_exceeded"
  | "upstream_error"
  | "internal";

export interface AnthropicMessageLike {
  stop_reason?: string | null;
  content: Array<{ type: string; text?: string }>;
}

/** The slice of the official Anthropic SDK client the proxy uses. Tests
 * inject a fake; src/index.ts injects `new Anthropic({ apiKey })`. */
export interface AnthropicLike {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      output_config?: { format: { type: "json_schema"; schema: Record<string, unknown> } };
    }): Promise<AnthropicMessageLike>;
  };
}

export interface ServerConfig {
  tokenSecret: string;
  dailyLimit: number;
}

export interface ServerDeps {
  anthropic: AnthropicLike;
  verifyAppleToken: AppleTokenVerifier;
  store: Store;
  clock: () => Date;
  config: ServerConfig;
}

class ApiError extends Error {
  readonly status: number;
  readonly type: ErrorType;

  constructor(status: number, type: ErrorType, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, type: ErrorType, message: string): void {
  sendJson(res, status, { error: { type, message } });
}

/** Reads the request body, enforcing the byte cap while streaming. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return; // keep draining so the 400 can be delivered
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        reject(new ApiError(400, "invalid_request", `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

function parseJsonBody(raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_request", "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_request", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

interface ListenerRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  tier: "reflection" | "question";
}

function validateListenerRequest(body: Record<string, unknown>): ListenerRequest {
  const { system, messages, maxTokens, tier } = body;
  if (typeof system !== "string") throw invalid("system must be a string");
  if (Buffer.byteLength(system, "utf8") > MAX_SYSTEM_BYTES) {
    throw invalid(`system exceeds ${MAX_SYSTEM_BYTES} bytes`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid("messages must be a non-empty array");
  }
  if (messages.length > MAX_MESSAGES) {
    throw invalid(`messages exceeds ${MAX_MESSAGES} entries`);
  }
  const validated: ListenerRequest["messages"] = [];
  for (const entry of messages) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalid("each message must be an object with role and content");
    }
    const { role, content } = entry as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") {
      throw invalid('message role must be "user" or "assistant"');
    }
    if (typeof content !== "string") throw invalid("message content must be a string");
    validated.push({ role, content });
  }
  if (validated[0]!.role !== "user") throw invalid('first message role must be "user"');
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) {
    throw invalid("maxTokens must be a positive integer");
  }
  if (maxTokens > MAX_MAX_TOKENS) throw invalid(`maxTokens exceeds ${MAX_MAX_TOKENS}`);
  if (tier !== "reflection" && tier !== "question") {
    throw invalid('tier must be "reflection" or "question"');
  }
  return { system, messages: validated, maxTokens, tier };
}

interface CoverageRequest {
  transcript: string;
  criteria: string[];
}

function validateCoverageRequest(body: Record<string, unknown>): CoverageRequest {
  const { transcript, criteria } = body;
  if (typeof transcript !== "string") throw invalid("transcript must be a string");
  if (Buffer.byteLength(transcript, "utf8") > MAX_TRANSCRIPT_BYTES) {
    throw invalid(`transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  if (!Array.isArray(criteria) || criteria.length < 1) {
    throw invalid("criteria must be a non-empty array");
  }
  if (criteria.length > MAX_CRITERIA) throw invalid(`criteria exceeds ${MAX_CRITERIA} entries`);
  for (const criterion of criteria) {
    if (typeof criterion !== "string" || criterion.length === 0) {
      throw invalid("each criterion must be a non-empty string");
    }
    if (criterion.length > MAX_CRITERION_CHARS) {
      throw invalid(`each criterion must be at most ${MAX_CRITERION_CHARS} characters`);
    }
  }
  return { transcript, criteria: criteria as string[] };
}

function firstTextBlock(response: AnthropicMessageLike): string {
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

export function createServer(deps: ServerDeps): http.Server {
  const { anthropic, verifyAppleToken, store, clock, config } = deps;

  async function requireAuth(req: IncomingMessage): Promise<string> {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new ApiError(401, "unauthorized", "missing bearer token");
    }
    const token = header.slice("Bearer ".length).trim();
    try {
      return await verifySessionToken(config.tokenSecret, token, clock());
    } catch {
      throw new ApiError(401, "unauthorized", "invalid or expired session token");
    }
  }

  /** 429 before touching the upstream; increments only after success. */
  async function checkQuota(userId: string): Promise<string> {
    const day = utcDay(clock());
    const count = await store.getCount(userId, day);
    if (count >= config.dailyLimit) {
      throw new ApiError(429, "quota_exceeded", "daily model call limit reached");
    }
    return day;
  }

  async function callAnthropic(
    params: Parameters<AnthropicLike["messages"]["create"]>[0],
  ): Promise<AnthropicMessageLike> {
    let response: AnthropicMessageLike;
    try {
      response = await anthropic.messages.create(params);
    } catch (err) {
      console.error("upstream Anthropic error:", err);
      throw new ApiError(502, "upstream_error", "upstream model call failed");
    }
    if (response.stop_reason === "refusal") {
      throw new ApiError(502, "upstream_error", "the model declined this request");
    }
    return response;
  }

  async function handleAuthApple(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parseJsonBody(await readBody(req, MAX_AUTH_BODY_BYTES));
    const { identityToken } = body;
    if (typeof identityToken !== "string" || identityToken.length === 0) {
      throw invalid("identityToken must be a non-empty string");
    }
    let sub: string;
    try {
      ({ sub } = await verifyAppleToken(identityToken));
    } catch {
      throw new ApiError(401, "unauthorized", "invalid Apple identity token");
    }
    const { token, expiresAt } = await issueSessionToken(config.tokenSecret, sub, clock());
    sendJson(res, 200, {
      sessionToken: token,
      userId: sub,
      expiresAt: expiresAt.toISOString(),
    });
  }

  async function handleListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = await requireAuth(req);
    const body = parseJsonBody(await readBody(req, MAX_LISTENER_BODY_BYTES));
    const request = validateListenerRequest(body);
    const day = await checkQuota(userId);
    const response = await callAnthropic({
      model: MODEL,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
    });
    await store.increment(userId, day);
    // An empty/missing text block is a valid reply: the model chose silence.
    sendJson(res, 200, { text: firstTextBlock(response) });
  }

  async function handleCoverage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = await requireAuth(req);
    const body = parseJsonBody(await readBody(req, MAX_COVERAGE_BODY_BYTES));
    const request = validateCoverageRequest(body);
    const day = await checkQuota(userId);
    const response = await callAnthropic({
      model: MODEL,
      max_tokens: COVERAGE_MAX_TOKENS,
      system: COVERAGE_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: coverageUserMessage(request.transcript, request.criteria) },
      ],
      output_config: { format: { type: "json_schema", schema: COVERAGE_SCHEMA } },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstTextBlock(response));
    } catch (err) {
      console.error("coverage: upstream returned non-JSON text block:", err);
      throw new ApiError(502, "upstream_error", "upstream model returned an invalid result");
    }
    const result = parseCoverageResult(parsed);
    if (result === null) {
      console.error("coverage: upstream JSON failed schema re-validation:", parsed);
      throw new ApiError(502, "upstream_error", "upstream model returned an invalid result");
    }
    await store.increment(userId, day);
    sendJson(res, 200, result);
  }

  async function handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = await requireAuth(req);
    const modelCallsToday = await store.getCount(userId, utcDay(clock()));
    sendJson(res, 200, {
      userId,
      usage: { modelCallsToday, dailyLimit: config.dailyLimit },
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    switch (key) {
      case "POST /v1/auth/apple":
        return handleAuthApple(req, res);
      case "POST /v1/listener":
        return handleListener(req, res);
      case "POST /v1/coverage":
        return handleCoverage(req, res);
      case "GET /v1/me":
        return handleMe(req, res);
      default:
        throw new ApiError(404, "invalid_request", "unknown route");
    }
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.writableEnded) return;
      if (err instanceof ApiError) {
        sendError(res, err.status, err.type, err.message);
      } else {
        console.error("internal error:", err);
        sendError(res, 500, "internal", "internal server error");
      }
    });
  });
}
