// Phase 2 — Step 4: extract the 6 deterministic fact types per scheme into
// corpus/facts.json — the structured layer the runtime reads directly, without
// the LLM, for numeric questions. See ARCHITECTURE.md §5–§6 Phase 2 and §7.
//
// Facts come from each scheme's OWN official scheme page only (edge case 2.8 —
// wrong-scheme numbers are the project's #1 risk; the scheme page is also the
// cleanest source vs. flattened PDF tables, edge case 2.2). Gemini 2.0 Flash
// does the first-pass extraction in strict JSON mode, grounded only in that
// page's text and told to return null rather than infer. lockIn is set
// deterministically from the SEBI category — never asked of the model.
//
// This script proposes values; the GitHub Actions refresh opens a PR and a
// human reviews the facts.json diff before it reaches production (ARCHITECTURE
// §7). The build still fails loudly if any of the 30 facts is missing (edge
// case 2.17), so an empty value can't slip through unnoticed.
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import {
  FACTS_PATH,
  type Source,
  extractedPath,
  loadEnv,
  log,
  readSources,
  readTextIfExists,
  requireEnv,
  sleep,
  warn,
  writeJson,
} from "./_shared";

// ARCHITECTURE.md §1 locks in `gemini-2.0-flash`, but Google has dropped it
// from the free tier (limit: 0). `gemini-2.5-flash-lite` is the current
// free-tier-friendly generation model — same vendor, same JSON schema mode,
// plenty for the 5 extraction calls this script makes. Worth updating the
// architecture doc in Phase 8.
const GEN_MODEL = "gemini-2.5-flash-lite";
const MAX_INPUT_CHARS = 100_000; // scheme-page text is far smaller; defensive cap
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 2_000;
const CALL_DELAY_MS = 1_000;

// The five LLM-extracted fact types (lockIn is derived, not extracted).
const EXTRACTED_FACTS = ["expenseRatio", "exitLoad", "minSIP", "riskometer", "benchmark"] as const;
type ExtractedFact = (typeof EXTRACTED_FACTS)[number];
type FactType = ExtractedFact | "lockIn";
const ALL_FACTS: FactType[] = [...EXTRACTED_FACTS, "lockIn"];

interface Fact {
  value: string;
  asOf: string;
  sourceId: string;
}
type SchemeFacts = { category: string } & Record<FactType, Fact>;

const EXTRACTION_PROMPT = `You extract factual data from an official HDFC Mutual Fund scheme page.

From the page text below, extract these fields for THIS scheme only:
- expenseRatio: the Total Expense Ratio (TER) of the Direct plan, e.g. "0.78%".
- exitLoad: the exit load, verbatim. If the page states there is none, return "Nil".
- minSIP: the minimum SIP / minimum systematic investment amount, e.g. "₹100".
- riskometer: the Risk-o-meter classification, e.g. "Very High".
- benchmark: the scheme's benchmark index, e.g. "NIFTY Midcap 150 TRI".

Rules:
- Use ONLY what is stated in the text. Do NOT infer, calculate, or use prior knowledge.
- If a field is not clearly stated for this scheme, return null for it.
- Return the value as a short, display-ready string. No commentary.
- Never include performance, returns, or NAV figures.

Page text:
"""
{{TEXT}}
"""`;

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: Object.fromEntries(
    EXTRACTED_FACTS.map((f) => [f, { type: SchemaType.STRING, nullable: true }]),
  ),
  // SDK types want a mutable string[] — spread out of the `as const` tuple.
  required: [...EXTRACTED_FACTS] as string[],
};

/** SEBI mandates a 3-year lock-in for ELSS; the other four categories have none. */
function lockInForCategory(category: string): string {
  return category.toLowerCase() === "elss" ? "3 years" : "Not applicable";
}

/** Light normalization for consistent, display-ready values (edge cases 2.9, 2.10). */
function normalizeValue(factType: FactType, raw: string): string {
  let v = raw.replace(/\s+/g, " ").trim();
  v = v.replace(/\bRs\.?\s?/gi, "₹").replace(/\bINR\s?/gi, "₹");
  v = v.replace(/₹\s+(?=\d)/g, "₹"); // drop the space the LLM sometimes inserts after ₹
  v = v.replace(/(\d)\s+%/g, "$1%");
  // The HDFC scheme pages render TER in a "Expense Ratio (%)" column where the
  // unit lives in the header; the LLM frequently drops it. Restore it.
  if (factType === "expenseRatio" && /^\d+(\.\d+)?$/.test(v)) v = `${v}%`;
  if (factType === "exitLoad" && /^(nil|none|n\.?a\.?|not applicable|zero|0%?)$/i.test(v)) {
    v = "Nil";
  }
  return v;
}

type GenModel = ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;

/** One Gemini extraction call with exponential-backoff retry on rate limits. */
async function extractRaw(
  model: GenModel,
  text: string,
  attempt = 1,
): Promise<Record<ExtractedFact, string | null>> {
  try {
    const prompt = EXTRACTION_PROMPT.replace("{{TEXT}}", text.slice(0, MAX_INPUT_CHARS));
    const res = await model.generateContent(prompt);
    return JSON.parse(res.response.text()) as Record<ExtractedFact, string | null>;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const retryable = /\b(429|500|503)\b|rate|quota|deadline|timeout|ECONN|fetch failed/i.test(msg);
    if (retryable && attempt <= MAX_RETRIES) {
      const wait = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      warn("4-build-facts", `extraction failed (${msg.slice(0, 120)}) — retry ${attempt}/${MAX_RETRIES} in ${wait}ms`);
      await sleep(wait);
      return extractRaw(model, text, attempt + 1);
    }
    throw err;
  }
}

/** Build the fact block for one scheme from its own scheme-page source. */
async function factsForScheme(model: GenModel, page: Source): Promise<SchemeFacts | null> {
  const text = readTextIfExists(extractedPath(page.id));
  if (!text || text.trim().length === 0) {
    warn("4-build-facts", `${page.scheme}: no extracted text for ${page.id} — run 2-extract`);
    return null;
  }
  if (!page.fetchedAt) {
    warn("4-build-facts", `${page.id}: missing fetchedAt — facts.json asOf would be dishonest`);
    return null;
  }

  const raw = await extractRaw(model, text);
  const cite = (value: string): Fact => ({
    value,
    asOf: page.fetchedAt as string,
    sourceId: page.id,
  });

  const facts: SchemeFacts = {
    category: page.category,
    // lockIn is derived from the category, not extracted (edge case 2.9).
    lockIn: cite(lockInForCategory(page.category)),
  } as SchemeFacts;

  for (const factType of EXTRACTED_FACTS) {
    const value = raw[factType];
    if (value == null || String(value).trim() === "") {
      warn("4-build-facts", `${page.scheme}: ${factType} not found on the scheme page`);
      continue; // left absent — caught by the completeness check below
    }
    facts[factType] = cite(normalizeValue(factType, String(value)));
  }
  return facts;
}

async function main(): Promise<void> {
  loadEnv();
  const apiKey = requireEnv("GEMINI_API_KEY");
  const sources = readSources();

  const schemePages = sources.filter((s) => s.type === "scheme-page" && s.scheme);
  if (schemePages.length === 0) {
    console.error("[4-build-facts] ERROR: no scheme-page sources in sources.json.");
    process.exit(1);
  }

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: GEN_MODEL,
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema },
  });

  const factsByScheme: Record<string, SchemeFacts> = {};
  for (const page of schemePages) {
    const facts = await factsForScheme(model, page);
    if (facts) {
      factsByScheme[page.scheme as string] = facts;
      const found = ALL_FACTS.filter((f) => facts[f]).length;
      log("4-build-facts", `${page.scheme}: ${found}/${ALL_FACTS.length} facts`);
    }
    await sleep(CALL_DELAY_MS);
  }

  // Deterministic output: schemes sorted by name, facts in a fixed order (edge 2.12).
  const ordered: Record<string, SchemeFacts> = {};
  for (const scheme of Object.keys(factsByScheme).sort()) {
    const src = factsByScheme[scheme];
    const block = { category: src.category } as SchemeFacts;
    for (const factType of ALL_FACTS) if (src[factType]) block[factType] = src[factType];
    ordered[scheme] = block;
  }

  // Completeness gate: every scheme needs all 6 facts with a non-empty value
  // and a valid sourceId (edge cases 2.8, 2.17).
  const sourceIds = new Set(sources.map((s) => s.id));
  const problems: string[] = [];
  for (const page of schemePages) {
    const scheme = page.scheme as string;
    const block = ordered[scheme];
    if (!block) {
      problems.push(`${scheme}: no facts built`);
      continue;
    }
    for (const factType of ALL_FACTS) {
      const fact = block[factType];
      if (!fact || !fact.value.trim()) problems.push(`${scheme}.${factType}: missing`);
      else if (!sourceIds.has(fact.sourceId)) {
        problems.push(`${scheme}.${factType}: unknown sourceId "${fact.sourceId}"`);
      }
    }
  }

  // facts.json matches the ARCHITECTURE §5 contract exactly — keyed by scheme,
  // no metadata wrapper — so Phase 3's facts.ts has a clean lookup target.
  writeJson(FACTS_PATH, ordered);

  if (problems.length > 0) {
    warn("4-build-facts", `INCOMPLETE — fix before the Phase 2 gate can pass:`);
    for (const p of problems) warn("4-build-facts", `  - ${p}`);
    process.exitCode = 1;
  }

  log(
    "4-build-facts",
    `done — ${Object.keys(ordered).length} scheme(s) written to corpus/facts.json` +
      (problems.length > 0 ? ` (${problems.length} issue(s) — see above)` : ""),
  );
  log("4-build-facts", "REVIEW corpus/facts.json against the live scheme pages before committing.");
}

main().catch((err) => {
  console.error(`[4-build-facts] ERROR: ${(err as Error).message}`);
  process.exit(1);
});
