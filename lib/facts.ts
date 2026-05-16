// Phase 3 — deterministic structured lookup over corpus/facts.json.
// When the query names a scheme AND a fact type we know about, we serve the
// answer straight from the curated facts file — no LLM, no retrieval, no risk
// of returning the wrong scheme's number (architecture's #1 failure mode).
//
// Scheme aliases include the pre-rename names (HDFC Top 100, HDFC TaxSaver,
// HDFC Equity, HDFC Focused 30) so a user typing the name they remember
// still resolves correctly (edge case 3.17).

import factsData from "@/corpus/facts.json";
import sourcesData from "@/corpus/sources.json";
import { FACT_TYPES, type FactType, type StoredFact } from "./contracts";

interface SchemeAlias {
  canonical: string;
  aliases: string[];
}

const SCHEME_ALIASES: SchemeAlias[] = [
  {
    canonical: "HDFC Mid-Cap Opportunities Fund",
    aliases: [
      "hdfc mid-cap opportunities",
      "hdfc mid cap opportunities",
      "mid-cap opportunities",
      "mid cap opportunities",
      "hdfc midcap",
      "hdfc mid-cap",
      "hdfc mid cap",
    ],
  },
  {
    canonical: "HDFC Flexi Cap Fund",
    aliases: [
      "hdfc flexi cap",
      "hdfc flexi-cap",
      "hdfc flexicap",
      "flexi cap",
      "flexi-cap",
      "flexicap",
      "hdfc equity fund",
      "hdfc equity",
    ],
  },
  {
    canonical: "HDFC Focused Fund",
    aliases: [
      "hdfc focused fund",
      "hdfc focused 30",
      "focused 30",
      "hdfc focused",
      "focused fund",
    ],
  },
  {
    canonical: "HDFC ELSS Tax Saver",
    aliases: [
      "hdfc elss tax saver",
      "hdfc elss",
      "hdfc tax saver",
      "hdfc taxsaver",
      "elss tax saver",
      "tax saver",
      "taxsaver",
      "elss",
    ],
  },
  {
    canonical: "HDFC Large Cap Fund",
    aliases: [
      "hdfc large cap",
      "hdfc large-cap",
      "hdfc largecap",
      "hdfc top 100",
      "hdfc top100",
      "large cap fund",
      "large-cap fund",
      "top 100",
    ],
  },
];

// Phrases that, when present in the query, map to a fact type. The order is
// important: the more specific phrases come first so "minimum sip" wins over
// "sip", "exit load" over "load", etc.
const FACT_TYPE_KEYWORDS: { factType: FactType; phrases: string[] }[] = [
  {
    factType: "expenseRatio",
    phrases: ["expense ratio", "ter", "total expense ratio", "expense"],
  },
  { factType: "exitLoad", phrases: ["exit load", "exit-load", "exit charge"] },
  {
    factType: "minSIP",
    phrases: [
      "minimum sip",
      "min sip",
      "min monthly sip",
      "minimum systematic investment",
      "minimum investment",
      "smallest sip",
    ],
  },
  {
    factType: "lockIn",
    phrases: ["lock in", "lock-in", "lockin", "lock period"],
  },
  {
    factType: "riskometer",
    phrases: ["riskometer", "risk-o-meter", "risk level", "risk classification", "risk rating"],
  },
  { factType: "benchmark", phrases: ["benchmark", "bench mark", "benchmark index"] },
];

// JSON's inferred shape is narrower than what we want to index by; widen via
// `unknown` so the structural-comparison check doesn't trip TS.
const facts = factsData as unknown as Record<
  string,
  { category: string } & Partial<Record<string, StoredFact>>
>;

interface SourceLookup {
  url: string;
  title: string;
  publisher: string;
}
const sourceById: Record<string, SourceLookup> = Object.fromEntries(
  (sourcesData as { id: string; url: string; title: string; publisher: string }[]).map((s) => [
    s.id,
    { url: s.url, title: s.title, publisher: s.publisher },
  ]),
);

/** Return every canonical scheme name the query mentions, longest-alias-first. */
export function detectSchemes(query: string): string[] {
  const q = query.toLowerCase();
  const hits: { canonical: string; aliasLen: number; pos: number }[] = [];
  for (const { canonical, aliases } of SCHEME_ALIASES) {
    let best: { aliasLen: number; pos: number } | null = null;
    for (const alias of aliases) {
      const pos = q.indexOf(alias);
      if (pos >= 0 && (!best || alias.length > best.aliasLen)) {
        best = { aliasLen: alias.length, pos };
      }
    }
    if (best) hits.push({ canonical, ...best });
  }
  // De-dup canonical, keep first-mention order.
  hits.sort((a, b) => a.pos - b.pos);
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(h.canonical) && seen.add(h.canonical)).map((h) => h.canonical);
}

/**
 * Return the fact type the query asks about, or null.
 *
 * Uses word-boundary matching, NOT raw substring matching: `"ter"` (the
 * shorthand for Total Expense Ratio) would otherwise false-match inside
 * `riskometer` and route a riskometer query to the expense-ratio fact (found
 * by Phase 5 testing). Word boundaries also keep "expense" from matching
 * "expenses" → "expenses" etc. should remain a deliberate phrase.
 */
const factTypeMatchers: { factType: FactType; res: RegExp[] }[] = FACT_TYPE_KEYWORDS.map(
  ({ factType, phrases }) => ({
    factType,
    res: phrases.map((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")),
  }),
);

export function detectFactType(query: string): FactType | null {
  for (const { factType, res } of factTypeMatchers) {
    if (res.some((re) => re.test(query))) return factType;
  }
  return null;
}

/** Look up a single fact. Returns null if the combination isn't in facts.json. */
export function lookupFact(scheme: string, factType: FactType): StoredFact | null {
  const block = facts[scheme];
  if (!block) return null;
  const fact = block[factType];
  return fact && fact.value ? fact : null;
}

/** Resolve a sourceId to the citation `{url, label}` the response shape needs. */
export function citationForSourceId(sourceId: string, scheme?: string): { url: string; label: string } | null {
  const src = sourceById[sourceId];
  if (!src) return null;
  // Prefer a concise label: "HDFC AMC — HDFC Mid-Cap Opportunities Fund" over
  // the verbose source title where possible.
  const label = scheme ? `${src.publisher} — ${scheme}` : src.title;
  return { url: src.url, label };
}

export function isValidFactType(s: string): s is FactType {
  return (FACT_TYPES as readonly string[]).includes(s);
}
