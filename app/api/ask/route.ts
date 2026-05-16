// Phase 3 — POST /api/ask. Thin orchestrator over the lib/ pipeline.
// Order matches ARCHITECTURE.md §2 exactly:
//   1. PII guard      → never logged, never sent to the LLM
//   2. Performance ask → canned redirect to the official factsheet
//   3. Classifier     → factual | advisory | out_of_scope
//   4. Router         → facts.json lookup, RAG fallback, or canned response
//   5. Answer assembler enforces ≤3 sentences + exactly one citation
//
// Force Node runtime so static-imported corpus JSON and the regex-heavy guards
// behave the same in dev and on Vercel.

import { NextResponse } from "next/server";

import { classify } from "@/lib/classifier";
import { detectFactType, detectSchemes } from "@/lib/facts";
import { checkPII } from "@/lib/pii-guard";
import { retrieveTopKForScheme } from "@/lib/retriever";
import {
  askWhichSchemeResponse,
  emptyQueryResponse,
  factualResponse,
  noSourceResponse,
  outOfScopeResponse,
  performanceResponse,
  piiBlockedResponse,
  ragResponse,
  refusalResponse,
} from "@/lib/answer";
import type { AskResponse } from "@/lib/contracts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse<AskResponse>> {
  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (!question) return NextResponse.json(emptyQueryResponse());

  // 1. PII guard — runs FIRST. Never touch the LLM, never log the question.
  const pii = checkPII(question);
  if (pii.hit) {
    // Type-only log so we can monitor false positives without leaking PII.
    console.log(`[/api/ask] pii_blocked type=${pii.type}`);
    return NextResponse.json(piiBlockedResponse());
  }

  console.log(`[/api/ask] question: ${question.slice(0, 200)}`);

  // 2. Classify — rule pre-filter inside also catches performance + advisory.
  const intent = await classify(question);

  if (intent === "performance") return NextResponse.json(performanceResponse());
  if (intent === "advisory") return NextResponse.json(refusalResponse());
  if (intent === "out_of_scope") return NextResponse.json(outOfScopeResponse());

  // 3. Factual path. Try the deterministic facts.json lookup first.
  const schemes = detectSchemes(question);
  const factType = detectFactType(question);
  const scheme = schemes[0] ?? null;

  if (factType && scheme) {
    const determined = factualResponse(scheme, factType);
    if (determined) return NextResponse.json(determined);
    // Fact-type known but no value stored → fall through to RAG.
  }
  if (factType && !scheme) {
    // We know what they're asking about but not which scheme (edge 3.1, 3.14).
    return NextResponse.json(askWhichSchemeResponse());
  }

  // 4. RAG fallback — open-ended factual ("how do I download a statement?").
  try {
    const topK = await retrieveTopKForScheme(question, scheme, 4);
    return NextResponse.json(await ragResponse(question, scheme, topK));
  } catch (err) {
    console.error(`[/api/ask] RAG failed: ${(err as Error).message}`);
    return NextResponse.json(noSourceResponse());
  }
}
