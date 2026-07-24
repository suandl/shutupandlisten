// Server-side copy of the coverage-mode contract. Mirrors
// ios/ShutUpAndListenKit/Sources/TurnEngine/Coverage.swift — the schema is the
// contract; keep the prompt text and JSON schema in sync with that file.

export const COVERAGE_SYSTEM_PROMPT =
  "You are a completeness checker for a live voice recording. The speaker is " +
  "dictating and has a checklist of topics they intend to cover. You are given " +
  "the transcript so far and the checklist. For each topic, decide whether the " +
  "transcript has substantively covered it — a passing mention does not count " +
  "unless it actually conveys the substance. Quote or closely paraphrase the " +
  "covering passage as evidence. Then, if anything is missing, write ONE brief " +
  "nudge (a single sentence) pointing at the most important gap, phrased so the " +
  "speaker can pick it up and keep talking — not a summary, not praise, not " +
  "more than one question. If everything is covered, the nudge is an empty string.";

/** The JSON schema handed to the Messages API's structured outputs
 * (`output_config.format`), guaranteeing `CoverageResult` parses. */
export const COVERAGE_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          covered: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["topic", "covered", "evidence"],
        additionalProperties: false,
      },
    },
    nudge: { type: "string" },
  },
  required: ["topics", "nudge"],
  additionalProperties: false,
} as const;

export interface CoverageTopicResult {
  topic: string;
  covered: boolean;
  evidence: string;
}

export interface CoverageResult {
  topics: CoverageTopicResult[];
  nudge: string;
}

/** Builds the user message exactly the way Coverage.swift does. */
export function coverageUserMessage(transcript: string, criteria: string[]): string {
  const list = criteria.map((topic) => `- ${topic}`).join("\n");
  return `CHECKLIST:\n${list}\n\nTRANSCRIPT SO FAR:\n${
    transcript.length === 0 ? "(nothing transcribed yet)" : transcript
  }`;
}

/** Re-validates the model's JSON against the contract before returning it to
 * the client. Returns a clean `CoverageResult` (known fields only) or null. */
export function parseCoverageResult(value: unknown): CoverageResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.nudge !== "string") return null;
  if (!Array.isArray(obj.topics)) return null;
  const topics: CoverageTopicResult[] = [];
  for (const entry of obj.topics) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const t = entry as Record<string, unknown>;
    if (typeof t.topic !== "string") return null;
    if (typeof t.covered !== "boolean") return null;
    if (typeof t.evidence !== "string") return null;
    topics.push({ topic: t.topic, covered: t.covered, evidence: t.evidence });
  }
  return { topics, nudge: obj.nudge };
}
