// Phase 2 — Step 3: chunk the extracted text, embed each chunk with Gemini
// text-embedding-004, and write corpus/index.json (the RAG store loaded into
// memory at runtime). See ARCHITECTURE.md §5–§6 Phase 2.
//
// Chunking packs whole paragraphs to ~700 tokens with a slight overlap and only
// ever splits on paragraph/sentence boundaries (edge case 2.7). Every chunk's
// text is prefixed with its scheme + source title so a retrieved chunk can
// never be read away from the scheme it describes.
//
// Chunk IDs are deterministic (`<sourceId>#NNN`) and chunks keep source order,
// so an unchanged corpus re-runs to a near-zero diff (edge case 2.12).
//
// Embeddings are cached in corpus/.cache/embeddings.json keyed by content hash
// and flushed after every chunk — a rate-limit (edge case 2.6) or crash resumes
// instead of re-spending the whole free-tier quota. The embedding model name +
// vector dimension are recorded in index.json so a future model swap is caught
// instead of silently breaking cosine math (edge case 2.13).
//
// NOTE on the model: ARCHITECTURE.md §1 locks in `text-embedding-004`, but
// Google retired that model from the Gemini API catalog. `gemini-embedding-001`
// is the current GA replacement — same provider, same free tier, same task
// types. We pin `outputDimensionality: 768` so the index shape (and any future
// retriever cosine math) is unchanged from the original spec. The SDK's
// `EmbedContentRequest` type doesn't yet expose `outputDimensionality`, so this
// step calls the REST API directly.
import {
  CACHE_DIR,
  INDEX_PATH,
  type Source,
  extractedPath,
  loadEnv,
  log,
  readSources,
  readTextIfExists,
  requireEnv,
  sha256,
  sleep,
  today,
  warn,
  writeJson,
} from "./_shared";

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768; // pinned via outputDimensionality (Matryoshka)

// Chunk sizing — ~4 chars/token. Target ~700 tokens, hard ceiling ~900, well
// under the model's input-token limit.
const TARGET_CHARS = 2_800;
const MAX_CHARS = 3_600;
const MIN_TRAILING_CHARS = 250; // a smaller trailing chunk is merged back
const OVERLAP_CHARS = 400;

// embedContent is per-chunk for this model. Free tier caps token-throughput
// per minute (edge case 2.6) — empirically a 200ms cadence hits the TPM wall
// around chunk 40. Pacing at ~15 req/min stays under the limit; the per-chunk
// cache means a rerun resumes for free if anything trips it.
const CALL_DELAY_MS = 4_000;
const MAX_RETRIES = 6;
const BACKOFF_BASE_MS = 5_000;

const CACHE_PATH = `${CACHE_DIR}/embeddings.json`;

interface Chunk {
  chunkId: string;
  sourceId: string;
  scheme: string | null;
  title: string;
  type: string;
  text: string;
  url: string;
  fetchedAt: string;
}

interface EmbedCache {
  model: string;
  dimension: number;
  vectors: Record<string, number[]>;
}

// ── Chunking ────────────────────────────────────────────────────────────────

const splitParagraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

const splitSentences = (para: string): string[] =>
  para.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [para];

/** Hard-slice a string that has no usable boundary under MAX_CHARS. */
function hardSlice(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHARS) out.push(text.slice(i, i + MAX_CHARS));
  return out;
}

/**
 * Break extracted text into ~TARGET_CHARS units, splitting only on paragraph
 * then sentence boundaries, with an OVERLAP_CHARS tail carried into the next
 * chunk. A tiny trailing chunk is merged into its predecessor.
 */
function chunkBody(body: string): string[] {
  // 1. Normalize every paragraph into a unit no larger than MAX_CHARS.
  const units: string[] = [];
  for (const para of splitParagraphs(body)) {
    if (para.length <= MAX_CHARS) {
      units.push(para);
      continue;
    }
    let buf = "";
    for (const sentence of splitSentences(para)) {
      const parts = sentence.length > MAX_CHARS ? hardSlice(sentence) : [sentence];
      for (const part of parts) {
        if (buf && buf.length + 1 + part.length > MAX_CHARS) {
          units.push(buf);
          buf = part;
        } else {
          buf = buf ? `${buf} ${part}` : part;
        }
      }
    }
    if (buf) units.push(buf);
  }

  // 2. Greedily pack units to TARGET_CHARS, carrying an overlap tail.
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const unit of units) {
    if (currentLen > 0 && currentLen + unit.length + 2 > TARGET_CHARS) {
      chunks.push(current.join("\n\n"));
      const tail: string[] = [];
      let tailLen = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        if (tailLen + current[i].length > OVERLAP_CHARS) break;
        tail.unshift(current[i]);
        tailLen += current[i].length;
      }
      current = tail;
      currentLen = tailLen;
    }
    current.push(unit);
    currentLen += unit.length + 2;
  }
  if (current.length > 0) {
    const last = current.join("\n\n");
    if (last.length < MIN_TRAILING_CHARS && chunks.length > 0) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${last}`;
    } else {
      chunks.push(last);
    }
  }
  return chunks;
}

/** Build every chunk for one source, with a scheme/title context prefix. */
function chunksForSource(source: Source): Chunk[] {
  const text = readTextIfExists(extractedPath(source.id));
  if (!text || text.trim().length === 0) {
    warn("3-build-index", `${source.id}: no extracted text — skipped (run 2-extract)`);
    return [];
  }
  const context = source.scheme ? `${source.scheme} — ${source.title}` : source.title;
  if (!source.fetchedAt) {
    warn("3-build-index", `${source.id}: missing fetchedAt — falling back to today()`);
  }
  return chunkBody(text).map((body, i) => ({
    chunkId: `${source.id}#${String(i).padStart(3, "0")}`,
    sourceId: source.id,
    scheme: source.scheme,
    title: source.title,
    type: source.type,
    text: `${context}\n\n${body}`,
    url: source.url,
    fetchedAt: source.fetchedAt ?? today(),
  }));
}

// ── Embedding ───────────────────────────────────────────────────────────────

function loadCache(): EmbedCache {
  const raw = readTextIfExists(CACHE_PATH);
  if (raw) {
    try {
      const cache = JSON.parse(raw) as EmbedCache;
      // A model/dimension change invalidates every cached vector (edge 2.13).
      if (cache.model === EMBED_MODEL && cache.dimension === EMBED_DIM) return cache;
      warn("3-build-index", `embedding cache is for ${cache.model}/${cache.dimension} — discarded`);
    } catch {
      warn("3-build-index", "embedding cache unreadable — rebuilding from scratch");
    }
  }
  return { model: EMBED_MODEL, dimension: EMBED_DIM, vectors: {} };
}

const EMBED_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;

/** Embed one chunk via REST, with exponential-backoff retry on rate limits (edge 2.6). */
async function embedOne(apiKey: string, text: string, attempt = 1): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${EMBED_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: EMBED_DIM,
      }),
    });
  } catch (err) {
    return retryOrThrow(apiKey, text, attempt, `network: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      return retryOrThrow(apiKey, text, attempt, `HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    throw new Error(`embedContent HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { embedding?: { values?: number[] } };
  const values = json.embedding?.values;
  if (!values || values.length === 0) {
    throw new Error(`embedContent returned no embedding (response: ${JSON.stringify(json).slice(0, 200)})`);
  }
  return values;
}

async function retryOrThrow(
  apiKey: string,
  text: string,
  attempt: number,
  reason: string,
): Promise<number[]> {
  if (attempt > MAX_RETRIES) throw new Error(`embedContent gave up after ${MAX_RETRIES} retries — ${reason}`);
  const wait = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  warn("3-build-index", `embed failed (${reason}) — retry ${attempt}/${MAX_RETRIES} in ${wait}ms`);
  await sleep(wait);
  return embedOne(apiKey, text, attempt + 1);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const apiKey = requireEnv("GEMINI_API_KEY");
  const sources = readSources();

  // 1. Chunk everything.
  const chunks: Chunk[] = [];
  for (const source of sources) {
    const sourceChunks = chunksForSource(source);
    if (sourceChunks.length > 0) {
      log("3-build-index", `${source.id}: ${sourceChunks.length} chunk(s)`);
      chunks.push(...sourceChunks);
    }
  }
  if (chunks.length === 0) {
    console.error("[3-build-index] ERROR: no chunks produced — run 1-fetch and 2-extract first.");
    process.exit(1);
  }

  // 2. Embed, reusing cached vectors and flushing the cache after each batch.
  const cache = loadCache();
  const pending = chunks.filter((c) => !cache.vectors[sha256(c.text)]);
  log(
    "3-build-index",
    `${chunks.length} chunk(s); ${chunks.length - pending.length} cached, ${pending.length} to embed`,
  );

  for (let i = 0; i < pending.length; i++) {
    const chunk = pending[i];
    const vec = await embedOne(apiKey, chunk.text);
    if (vec.length !== EMBED_DIM) {
      throw new Error(`${chunk.chunkId}: embedding dimension ${vec.length} != ${EMBED_DIM}`);
    }
    cache.vectors[sha256(chunk.text)] = vec;
    // Flush after every chunk — a crash or 429 mid-run resumes from here.
    writeJson(CACHE_PATH, cache);
    if ((i + 1) % 20 === 0 || i + 1 === pending.length) {
      log("3-build-index", `embedded ${i + 1}/${pending.length}`);
    }
    if (i + 1 < pending.length) await sleep(CALL_DELAY_MS);
  }

  // 3. Assemble index.json — chunks in source order, embeddings from the cache.
  const embedded = chunks.map((chunk) => {
    const embedding = cache.vectors[sha256(chunk.text)];
    if (!embedding) throw new Error(`${chunk.chunkId}: embedding missing after build`);
    return { ...chunk, embedding };
  });

  writeJson(INDEX_PATH, {
    model: EMBED_MODEL,
    dimension: EMBED_DIM,
    builtAt: new Date().toISOString(),
    chunkCount: embedded.length,
    chunks: embedded,
  });
  log("3-build-index", `done — ${embedded.length} chunk(s) written to corpus/index.json`);
}

main().catch((err) => {
  console.error(`[3-build-index] ERROR: ${(err as Error).message}`);
  process.exit(1);
});
