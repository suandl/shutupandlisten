// Entry point: wires real dependencies from the environment and listens.

import Anthropic from "@anthropic-ai/sdk";
import { makeAppleVerifier } from "./auth.ts";
import { FileStore } from "./store.ts";
import { createServer } from "./server.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const apiKey = requireEnv("ANTHROPIC_API_KEY");
const tokenSecret = requireEnv("TOKEN_SECRET");
const appleBundleId = process.env.APPLE_BUNDLE_ID ?? "sh.shutupandlisten.ios";
const dailyLimit = Number.parseInt(process.env.DAILY_MODEL_CALL_LIMIT ?? "200", 10);
const dataDir = process.env.DATA_DIR ?? "./data";
const port = Number.parseInt(process.env.PORT ?? "8787", 10);

if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
  console.error("DAILY_MODEL_CALL_LIMIT must be a positive integer");
  process.exit(1);
}

const server = createServer({
  anthropic: new Anthropic({ apiKey }),
  verifyAppleToken: makeAppleVerifier(appleBundleId),
  store: new FileStore(dataDir),
  clock: () => new Date(),
  config: { tokenSecret, dailyLimit },
});

server.listen(port, () => {
  console.log(`shutupandlisten proxy listening on :${port}`);
});
