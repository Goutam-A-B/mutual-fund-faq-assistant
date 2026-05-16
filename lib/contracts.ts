// Phase 3 — runtime types shared between lib/ modules and app/api/ask/route.ts.
// `AskResponse` is the wire contract from ARCHITECTURE.md §5; it is what the
// browser receives from POST /api/ask.

export type Intent = "factual" | "advisory" | "out_of_scope";

export type ResponseType = "answer" | "refusal" | "out_of_scope" | "pii_blocked";

export interface Citation {
  url: string;
  label: string;
}

export interface AskResponse {
  type: ResponseType;
  answer: string;
  citation: Citation | null;
  lastUpdated: string | null;
  intent: Intent | null;
}

export const FACT_TYPES = [
  "expenseRatio",
  "exitLoad",
  "minSIP",
  "lockIn",
  "riskometer",
  "benchmark",
] as const;
export type FactType = (typeof FACT_TYPES)[number];

/** Mirror of corpus/facts.json's value shape (per scheme, per fact type). */
export interface StoredFact {
  value: string;
  asOf: string;
  sourceId: string;
}
