// Phase 2 — Step 2: convert the snapshotted HTML/PDF in corpus/raw/ into clean
// UTF-8 text under corpus/extracted/, one <id>.txt per source. Steps 3 & 4 read
// these files — never the raw snapshots. See ARCHITECTURE.md §6 Phase 2.
//
// HTML: cheerio strips scripts/chrome, block elements become line breaks, table
//   cells are joined with " | " so label/value pairs survive (edge case 2.2).
// PDF:  pdf-parse extracts the text layer; an empty result means a scanned /
//   image-only PDF (edge case 2.3) — logged, not fatal.
// A scheme page that yields almost no text means hydration failed or the layout
// changed (edge cases 2.1, 2.17) — that fails the build loudly.
import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import {
  EXTRACTED_DIR,
  type Source,
  ensureDir,
  extractedPath,
  isPdf,
  log,
  normalizeText,
  readSources,
  snapshotPath,
  warn,
  writeJson,
  writeText,
} from "./_shared";

// Below this many characters an extract is treated as "essentially empty".
const MIN_USEFUL_CHARS = 200;
// Tags that never carry facts — dropped before text extraction.
const NOISE_SELECTOR =
  "script, style, noscript, svg, iframe, head, template, link, meta, nav, " +
  '[role="navigation"], header, footer, .cookie, #cookie';

interface ExtractResult {
  id: string;
  kind: "html" | "pdf";
  chars: number;
  status: "ok" | "thin" | "empty" | "missing" | "error";
  note?: string;
}

/** Strip chrome, turn block/table structure into newlines, return body text. */
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $(NOISE_SELECTOR).remove();

  $("br").replaceWith("\n");
  // Keep table rows readable: cells joined by " | ", one row per line.
  $("th, td").each((_, el) => {
    $(el).append(" | ");
  });
  $("tr").each((_, el) => {
    $(el).append("\n");
  });
  // Block elements each end a line.
  $(
    "p, div, li, h1, h2, h3, h4, h5, h6, section, article, ul, ol, table, " +
      "blockquote, dt, dd, tr",
  ).each((_, el) => {
    $(el).append("\n");
  });

  const body = $("body");
  return normalizeText(body.length ? body.text() : $.root().text());
}

/** Extract the text layer from a PDF buffer; "" for scanned/image-only PDFs. */
async function pdfToText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return normalizeText(data.text ?? "");
}

async function extractOne(source: Source): Promise<ExtractResult> {
  const kind: "html" | "pdf" = isPdf(source) ? "pdf" : "html";
  const snapshot = snapshotPath(source);

  let buffer: Buffer;
  try {
    buffer = readFileSync(snapshot);
  } catch {
    warn("2-extract", `${source.id}: no snapshot at ${source.localSnapshot} — run 1-fetch`);
    return { id: source.id, kind, chars: 0, status: "missing" };
  }

  let text: string;
  try {
    text = kind === "pdf" ? await pdfToText(buffer) : htmlToText(buffer.toString("utf8"));
  } catch (err) {
    warn("2-extract", `${source.id}: ${kind} parse failed — ${(err as Error).message}`);
    return { id: source.id, kind, chars: 0, status: "error", note: (err as Error).message };
  }

  // Mojibake guard (edge case 2.11) — snapshots should already be clean UTF-8.
  if (/Ã.|â€|â‚¬/.test(text)) {
    warn("2-extract", `${source.id}: possible mojibake in extracted text — check encoding`);
  }

  writeText(extractedPath(source.id), text.length > 0 ? `${text}\n` : "");

  if (text.length === 0) {
    const why =
      kind === "pdf" ? "scanned / image-only PDF (no text layer)" : "no text in HTML body";
    warn("2-extract", `${source.id}: empty extract — ${why}`);
    return { id: source.id, kind, chars: 0, status: "empty", note: why };
  }
  if (text.length < MIN_USEFUL_CHARS) {
    warn("2-extract", `${source.id}: thin extract (${text.length} chars) — verify the snapshot`);
    return { id: source.id, kind, chars: text.length, status: "thin" };
  }

  log("2-extract", `${source.id}: ${text.length} chars (${kind})`);
  return { id: source.id, kind, chars: text.length, status: "ok" };
}

async function main(): Promise<void> {
  ensureDir(EXTRACTED_DIR);
  const sources = readSources();
  const results: ExtractResult[] = [];

  for (const source of sources) {
    results.push(await extractOne(source));
  }

  // Manifest is an intermediate (gitignored) — handy for spot-checking the gate.
  writeJson(`${EXTRACTED_DIR}/_manifest.json`, {
    builtAt: new Date().toISOString(),
    sources: results,
  });

  const ok = results.filter((r) => r.status === "ok").length;
  log("2-extract", `done — ${ok}/${results.length} extracted cleanly`);

  const problems = results.filter((r) => r.status !== "ok");
  if (problems.length > 0) {
    warn(
      "2-extract",
      `needs attention: ${problems.map((r) => `${r.id} (${r.status})`).join(", ")}`,
    );
  }

  // Scheme pages feed facts.json — an empty/missing one means the Phase 2 gate
  // cannot pass, so fail loudly (edge cases 2.1, 2.17).
  const brokenSchemePages = sources.filter(
    (s) =>
      s.type === "scheme-page" &&
      results.find((r) => r.id === s.id)?.status !== "ok",
  );
  if (brokenSchemePages.length > 0) {
    warn(
      "2-extract",
      `CRITICAL — scheme pages not usable: ${brokenSchemePages.map((s) => s.id).join(", ")}`,
    );
    process.exitCode = 1;
  }
}

main();
