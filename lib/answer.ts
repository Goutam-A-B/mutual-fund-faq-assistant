// Phase 3 — answer assembler. Owns every response shape POST /api/ask can
// return: deterministic factual answers from facts.json, RAG synthesis for
// open-ended factual queries, plus the canned refusal / out-of-scope /
// performance / no-source / PII / ask-which-scheme messages.
//
// Every "answer" response carries exactly one citation and ≤ 3 sentences
// (edges 3.11, 3.12). Refusals carry an educational link per the brief; the
// other canned messages may or may not, depending on what makes sense.

import { citationForSourceId, lookupFact } from "./facts";
import { generateJSON } from "./gemini";
import type { ScoredChunk } from "./retriever";
import type { AskResponse, Citation, FactType, StoredFact } from "./contracts";

// Below this top-1 cosine score we don't even ask the LLM — the corpus
// obviously doesn't cover the topic (edge case 3.9).
const RAG_MIN_TOP_SCORE = 0.25;

// Hard-coded citations for canned messages (these sourceIds exist in
// sources.json so they round-trip through citationForSourceId).
const AMFI_INVESTOR_CORNER = "amfi-investor-corner";
const FACTSHEETS_HUB = "hdfc-factsheets-hub";

const SCHEME_LIST =
  "HDFC Mid-Cap Opportunities Fund, HDFC Flexi Cap Fund, HDFC Focused Fund, " +
  "HDFC ELSS Tax Saver, and HDFC Large Cap Fund";

// ── Sentence clamp ─────────────────────────────────────────────────────────

/**
 * Keep the first three sentences. Splits on a sentence terminator FOLLOWED by
 * whitespace (or end-of-string), so a `.` inside a number ("0.80%") doesn't
 * count as a boundary. Lone fragments without a terminator come through whole.
 */
function clampToThreeSentences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  return parts.slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
}

// ── Deterministic factual answers (facts.json hits) ────────────────────────

function templateFor(scheme: string, factType: FactType, fact: StoredFact): string {
  const v = fact.value;
  switch (factType) {
    case "expenseRatio":
      return `The expense ratio of ${scheme} (Direct plan) is ${v}.`;
    case "exitLoad":
      return v.toLowerCase() === "nil"
        ? `${scheme} has no exit load.`
        : `Exit load for ${scheme}: ${v}`;
    case "minSIP":
      return `The minimum SIP for ${scheme} is ${v}.`;
    case "lockIn":
      return v === "Not applicable"
        ? `${scheme} has no lock-in period.`
        : `${scheme} has a lock-in period of ${v}.`;
    case "riskometer":
      return `${scheme}'s riskometer classification is "${v}".`;
    case "benchmark":
      return `The benchmark index for ${scheme} is ${v}.`;
  }
}

export function factualResponse(scheme: string, factType: FactType): AskResponse | null {
  const fact = lookupFact(scheme, factType);
  if (!fact) return null;
  const citation = citationForSourceId(fact.sourceId, scheme);
  if (!citation) return null; // refuse rather than answer uncited (edge 3.12)
  return {
    type: "answer",
    answer: clampToThreeSentences(templateFor(scheme, factType, fact)),
    citation,
    lastUpdated: fact.asOf,
    intent: "factual",
  };
}

// ── RAG synthesis path ─────────────────────────────────────────────────────

const SYNTHESIS_PROMPT = `You answer factual questions about HDFC mutual funds using ONLY the passages below. Each passage is labelled with a sourceId.

Hard rules:
- Use only the text in the passages. Do NOT use any prior knowledge.
- Answer in at most 3 sentences. Plain English. No lists or bullets.
- Never give advice, opinions, recommendations, or comparisons.
- Never quote performance, returns, CAGR, or NAV figures, even if a passage contains them.
- If the passages do not clearly answer the question, set "answered" to false and leave "answer" empty.
- "primarySourceId" must be the sourceId of the passage you used. If "answered" is false, use null.

Question:
"""
{{QUERY}}
"""

Passages:
{{PASSAGES}}`;

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    answered: { type: "boolean" },
    answer: { type: "string" },
    primarySourceId: { type: "string", nullable: true },
  },
  required: ["answered", "answer", "primarySourceId"],
} as const;

interface SynthesisJson {
  answered: boolean;
  answer: string;
  primarySourceId: string | null;
}

export async function ragResponse(
  query: string,
  scheme: string | null,
  topK: ScoredChunk[],
): Promise<AskResponse> {
  if (topK.length === 0 || topK[0].score < RAG_MIN_TOP_SCORE) {
    return noSourceResponse();
  }
  const passages = topK
    .map(
      ({ chunk }, i) =>
        `Passage ${i + 1} (sourceId=${chunk.sourceId}):\n${chunk.text}`,
    )
    .join("\n\n---\n\n");

  let out: SynthesisJson;
  try {
    out = await generateJSON<SynthesisJson>(
      SYNTHESIS_PROMPT.replace("{{QUERY}}", query).replace("{{PASSAGES}}", passages),
      SYNTHESIS_SCHEMA,
    );
  } catch {
    return noSourceResponse(); // LLM failure → safe path (edge 3.8)
  }

  if (!out.answered || !out.answer.trim() || !out.primarySourceId) {
    return noSourceResponse();
  }
  const citation = citationForSourceId(out.primarySourceId, scheme ?? undefined);
  if (!citation) return noSourceResponse(); // edge 3.12

  // The chunk we cited (by sourceId) carries the fetchedAt we need.
  const cited = topK.find((c) => c.chunk.sourceId === out.primarySourceId);
  const lastUpdated = cited?.chunk.fetchedAt ?? topK[0].chunk.fetchedAt;

  return {
    type: "answer",
    answer: clampToThreeSentences(out.answer),
    citation,
    lastUpdated,
    intent: "factual",
  };
}

// ── Canned responses ───────────────────────────────────────────────────────

function citation(sourceId: string, fallback: Citation): Citation {
  return citationForSourceId(sourceId) ?? fallback;
}

export function refusalResponse(): AskResponse {
  return {
    type: "refusal",
    answer:
      "I can only share factual information from official sources — I don't give investment advice, recommendations, or comparisons. For investor education, AMFI's Investor Corner is a good starting point.",
    citation: citation(AMFI_INVESTOR_CORNER, {
      url: "https://www.amfiindia.com/investor",
      label: "AMFI — Investor Corner",
    }),
    lastUpdated: null,
    intent: "advisory",
  };
}

export function outOfScopeResponse(): AskResponse {
  return {
    type: "out_of_scope",
    answer: `I can only answer factual questions about these 5 HDFC schemes: ${SCHEME_LIST}.`,
    citation: null,
    lastUpdated: null,
    intent: "out_of_scope",
  };
}

export function performanceResponse(): AskResponse {
  return {
    type: "out_of_scope",
    answer:
      "By design, I don't quote or compute scheme performance, returns, CAGR, or NAV. The latest performance and NAV are published on the official HDFC Mutual Fund factsheet page.",
    citation: citation(FACTSHEETS_HUB, {
      url: "https://www.hdfcfund.com/investor-services/factsheets",
      label: "HDFC AMC — Fund Factsheets",
    }),
    lastUpdated: null,
    intent: "out_of_scope",
  };
}

export function noSourceResponse(): AskResponse {
  return {
    type: "out_of_scope",
    answer:
      "I don't have that in the official sources I'm allowed to draw from. Try a question about expense ratio, exit load, minimum SIP, lock-in, riskometer, benchmark, or how to download a statement.",
    citation: null,
    lastUpdated: null,
    intent: "out_of_scope",
  };
}

export function askWhichSchemeResponse(): AskResponse {
  return {
    type: "out_of_scope",
    answer: `Which scheme are you asking about? In scope: ${SCHEME_LIST}.`,
    citation: null,
    lastUpdated: null,
    intent: "out_of_scope",
  };
}

export function piiBlockedResponse(): AskResponse {
  return {
    type: "pii_blocked",
    answer:
      "This service cannot process PAN, Aadhaar, account numbers, OTPs, phone numbers, or email addresses. Please rephrase your question without those details.",
    citation: null,
    lastUpdated: null,
    intent: null,
  };
}

export function emptyQueryResponse(): AskResponse {
  return {
    type: "out_of_scope",
    answer: `Ask me a factual question about one of: ${SCHEME_LIST}.`,
    citation: null,
    lastUpdated: null,
    intent: "out_of_scope",
  };
}
