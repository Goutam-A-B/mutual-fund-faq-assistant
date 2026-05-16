// Phase 2 — shared helpers for the offline ingestion pipeline.
// Path resolution, atomic UTF-8 (no-BOM) writes, deterministic JSON, logging.
// See ARCHITECTURE.md §6 Phase 2 and docs/edge-cases.md §4 (Phase 2).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROOT = process.cwd();
export const CORPUS_DIR = join(ROOT, "corpus");
export const RAW_DIR = join(CORPUS_DIR, "raw");
export const EXTRACTED_DIR = join(CORPUS_DIR, "extracted");
export const CACHE_DIR = join(CORPUS_DIR, ".cache");
export const SOURCES_PATH = join(CORPUS_DIR, "sources.json");
export const INDEX_PATH = join(CORPUS_DIR, "index.json");
export const FACTS_PATH = join(CORPUS_DIR, "facts.json");

/** One entry in corpus/sources.json — see ARCHITECTURE.md §5. */
export interface Source {
  id: string;
  scheme: string | null;
  category: string;
  type: string;
  title: string;
  url: string;
  publisher: string;
  fetchedAt: string | null;
  localSnapshot: string;
  notes?: string;
}

export function readSources(): Source[] {
  return JSON.parse(readFileSync(SOURCES_PATH, "utf8")) as Source[];
}

export function writeSources(sources: Source[]): void {
  writeJson(SOURCES_PATH, sources);
}

/** Resolve a sources.json `localSnapshot` (repo-relative) to an absolute path. */
export function snapshotPath(source: Source): string {
  return join(ROOT, source.localSnapshot);
}

/** Per-source extracted-text path, written by 2-extract and read by 3 & 4. */
export function extractedPath(id: string): string {
  return join(EXTRACTED_DIR, `${id}.txt`);
}

export function isPdf(source: Source): boolean {
  return source.localSnapshot.toLowerCase().endsWith(".pdf");
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Write to a temp sibling then rename — an interrupted or OneDrive-locked
 * write can't leave a truncated artifact behind (edge case 2.14).
 */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data); // strings default to UTF-8, no BOM (edge case 2.11)
  renameSync(tmp, path);
}

/** Deterministic JSON artifact: 2-space indent, trailing newline, UTF-8. */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(path: string, text: string): void {
  writeFileAtomic(path, text);
}

export function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Today as YYYY-MM-DD — feeds `fetchedAt` and each fact's `asOf`. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function log(scope: string, msg: string): void {
  console.log(`[${scope}] ${msg}`);
}

export function warn(scope: string, msg: string): void {
  console.warn(`[${scope}] WARN: ${msg}`);
}

/**
 * Load `.env.local` into `process.env` if present. tsx does not auto-load env
 * files; steps 3 & 4 need GEMINI_API_KEY. No-op when the file is absent (CI
 * passes the key as a real env var instead).
 */
export function loadEnv(): void {
  const envPath = join(ROOT, ".env.local");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    warn("env", `could not load .env.local: ${(err as Error).message}`);
  }
}

/** Read a required env var or exit with a clear, actionable message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[env] ERROR: ${name} is not set. Add it to .env.local (see ` +
        `.env.local.example) or export it before running the pipeline.`,
    );
    process.exit(1);
  }
  return value;
}

/** Stable content hash — keys the embedding cache and keeps chunk reuse honest. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Normalize extracted text: NFC unicode, drop zero-width chars, fold every
 * horizontal whitespace run (nbsp, ideographic, en/em, tabs, ...) to a single
 * plain space, trim each line, collapse 3+ blank lines to 2 (edge cases 2.10,
 * 2.11). `[^\S\n]` is "whitespace that is not a newline" — it covers all the
 * exotic Unicode spaces without spelling them out. The Rupee sign and other
 * meaningful UTF-8 are left untouched.
 */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
