// Phase 3 — thin REST wrapper around the two Gemini endpoints we need at
// runtime: embedContent (query embedding) and generateContent (classification +
// RAG synthesis). Uses the same models as the Phase 2 build so cosine math and
// JSON-mode behavior stay consistent.
//
// We deliberately call REST directly (not @google/generative-ai) because the
// SDK shipped with this project doesn't expose `outputDimensionality` and a
// dim mismatch between build-time and query-time vectors would silently break
// retrieval (edge case 2.13). Same reasoning as scripts/3-build-index.ts.

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768; // must match corpus/index.json
// Default generation model. Overridable via GEMINI_GEN_MODEL — handy when one
// model has exhausted its free-tier daily quota and the test harness needs to
// fall back to a sibling. Read lazily so the env var can be set after this
// module loads (e.g. by scripts/5-test.ts before the first request).
const DEFAULT_GEN_MODEL = "gemini-2.5-flash-lite";
function genModel(): string {
  return process.env.GEMINI_GEN_MODEL?.trim() || DEFAULT_GEN_MODEL;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 800;

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

/** Sleep without leaking a setTimeout if the AbortController fires (no-op fine). */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function postWithRetry(url: string, body: unknown, label: string): Promise<unknown> {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      const retryable = [429, 500, 502, 503, 504].includes(res.status);
      if (retryable && attempt <= MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error).message;
      const isAbort = (err as Error).name === "AbortError";
      if ((isAbort || /fetch failed|ECONN|network/i.test(msg)) && attempt <= MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label}: retries exhausted`);
}

/**
 * Embed the user's query with the same model + dimension used to build the
 * index (edge case 2.13). `taskType: RETRIEVAL_QUERY` is the correct asymmetric
 * pair to the `RETRIEVAL_DOCUMENT` used during indexing.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const json = (await postWithRetry(
    `${API_BASE}/${EMBED_MODEL}:embedContent?key=${apiKey()}`,
    {
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EMBED_DIM,
    },
    "embedContent",
  )) as { embedding?: { values?: number[] } };
  const values = json.embedding?.values;
  if (!values || values.length !== EMBED_DIM) {
    throw new Error(`embedContent returned ${values?.length ?? 0} dims (expected ${EMBED_DIM})`);
  }
  return values;
}

/**
 * Generate JSON conforming to `responseSchema`. The model is forced into JSON
 * mode with `responseMimeType`, so the caller can trust JSON.parse on the
 * returned text (modulo the safety wrapper below for edge case 3.10).
 */
export async function generateJSON<T>(prompt: string, responseSchema: object): Promise<T> {
  const json = (await postWithRetry(
    `${API_BASE}/${genModel()}:generateContent?key=${apiKey()}`,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema,
      },
    },
    "generateContent",
  )) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("generateContent: empty response");
  return JSON.parse(text) as T;
}

/** Plain text generation (no schema). Used by the RAG synthesis prompt. */
export async function generateText(prompt: string): Promise<string> {
  const json = (await postWithRetry(
    `${API_BASE}/${genModel()}:generateContent?key=${apiKey()}`,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    },
    "generateContent",
  )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (json.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
}
