// Phase 3 — in-memory cosine similarity over corpus/index.json. The index is
// static-imported so it's bundled with the route at build time (3 MB, ~150
// chunks × 768 floats) and loaded once per cold start (edge case 3.15).
//
// We deliberately load the WHOLE index into a flat array and score linearly —
// at 171 chunks a top-k pass is ~0.5 ms, simpler than any vector store and
// removes a whole class of infra risks.

import indexData from "@/corpus/index.json";
import { embedQuery } from "./gemini";

interface IndexChunk {
  chunkId: string;
  sourceId: string;
  scheme: string | null;
  title: string;
  type: string;
  text: string;
  url: string;
  fetchedAt: string;
  embedding: number[];
}

interface IndexFile {
  model: string;
  dimension: number;
  builtAt: string;
  chunkCount: number;
  chunks: IndexChunk[];
}

const index = indexData as unknown as IndexFile;

export interface ScoredChunk {
  chunk: IndexChunk;
  score: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embed `query` with the same model used to build the index, then return the
 * top-k chunks by cosine similarity. Caller decides what to do with low-score
 * results (edge case 3.9).
 */
export async function retrieveTopK(query: string, k = 4): Promise<ScoredChunk[]> {
  const qVec = await embedQuery(query);
  if (qVec.length !== index.dimension) {
    throw new Error(
      `query dim ${qVec.length} != index dim ${index.dimension} — rebuild corpus or check model pin`,
    );
  }
  const scored: ScoredChunk[] = index.chunks.map((chunk) => ({
    chunk,
    score: cosine(qVec, chunk.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Same as `retrieveTopK` but optionally filtered to a single scheme — useful
 * when the query names a scheme but doesn't match a structured fact type.
 */
export async function retrieveTopKForScheme(
  query: string,
  scheme: string | null,
  k = 4,
): Promise<ScoredChunk[]> {
  if (!scheme) return retrieveTopK(query, k);
  const qVec = await embedQuery(query);
  const scored: ScoredChunk[] = index.chunks
    .filter((c) => c.scheme === scheme || c.scheme === null) // include cross-cutting docs (AMFI/SEBI/FAQ)
    .map((chunk) => ({ chunk, score: cosine(qVec, chunk.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function indexMeta(): { model: string; dimension: number; chunkCount: number; builtAt: string } {
  return {
    model: index.model,
    dimension: index.dimension,
    chunkCount: index.chunkCount,
    builtAt: index.builtAt,
  };
}
