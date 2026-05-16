// Phase 2 — Step 1: download + snapshot official sources into corpus/raw/.
// HTML pages go through Playwright (headless Chromium, real user-agent) so
// JS-rendered hdfcfund.com pages hydrate before we snapshot (edge case 2.1);
// PDFs are downloaded directly. Snapshots are committed for reproducibility.
// See ARCHITECTURE.md §6 Phase 2.
import { chromium, type Browser } from "playwright";
import {
  RAW_DIR,
  type Source,
  ensureDir,
  isPdf,
  log,
  readSources,
  sleep,
  snapshotPath,
  today,
  warn,
  writeFileAtomic,
  writeSources,
} from "./_shared";

// A real desktop Chrome UA — hdfcfund.com 403s naive clients (edge case 2.16).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NAV_TIMEOUT_MS = 45_000;
const POLITE_DELAY_MS = 1_500; // spacing + single-page concurrency — edge case 2.16

/** Snapshot a JS-rendered HTML page once it has hydrated. */
async function fetchHtml(browser: Browser, source: Source): Promise<boolean> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: "en-IN",
    extraHTTPHeaders: {
      "Accept-Language": "en-IN,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });
  const page = await context.newPage();
  try {
    const resp = await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    const status = resp?.status() ?? 0;
    if (status >= 400) {
      warn("1-fetch", `${source.id}: HTTP ${status} for ${source.url}`);
      return false;
    }
    // Give client-side hydration a chance to render the facts (edge case 2.1).
    await page
      .waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS })
      .catch(() => undefined);
    await page.waitForTimeout(1_500);
    const html = await page.content();
    if (html.length < 2_000) {
      warn("1-fetch", `${source.id}: suspiciously small HTML (${html.length} bytes)`);
    }
    writeFileAtomic(snapshotPath(source), html);
    log("1-fetch", `${source.id}: saved HTML (${html.length} bytes, HTTP ${status})`);
    return true;
  } catch (err) {
    warn("1-fetch", `${source.id}: ${(err as Error).message}`);
    return false;
  } finally {
    await context.close();
  }
}

/** Download a PDF directly and sanity-check the %PDF header (edge cases 2.3, 2.5). */
async function fetchPdf(source: Source): Promise<boolean> {
  try {
    const resp = await fetch(source.url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" },
      redirect: "follow",
    });
    if (!resp.ok) {
      warn("1-fetch", `${source.id}: HTTP ${resp.status} for ${source.url}`);
      return false;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1_000 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      warn("1-fetch", `${source.id}: response is not a valid PDF (${buf.length} bytes)`);
      return false;
    }
    writeFileAtomic(snapshotPath(source), buf);
    log("1-fetch", `${source.id}: saved PDF (${buf.length} bytes)`);
    return true;
  } catch (err) {
    warn("1-fetch", `${source.id}: ${(err as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  ensureDir(RAW_DIR);
  const sources = readSources();
  const browser = await chromium.launch({ headless: true });
  const failed: string[] = [];

  try {
    for (const source of sources) {
      const success = isPdf(source)
        ? await fetchPdf(source)
        : await fetchHtml(browser, source);
      if (success) {
        source.fetchedAt = today();
      } else {
        failed.push(source.id);
      }
      await sleep(POLITE_DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  // Persist fetchedAt for the successful sources so `asOf` stays honest later.
  writeSources(sources);

  const ok = sources.length - failed.length;
  log("1-fetch", `done — ${ok}/${sources.length} fetched`);
  if (failed.length > 0) {
    warn("1-fetch", `failed: ${failed.join(", ")}`);
  }

  // Scheme pages are the authoritative source for facts.json — a missing one
  // means the Phase 2 gate cannot pass, so fail loudly (edge cases 2.5, 2.17).
  const criticalMissing = sources.filter(
    (s) => s.type === "scheme-page" && failed.includes(s.id),
  );
  if (criticalMissing.length > 0) {
    warn(
      "1-fetch",
      `CRITICAL — scheme pages missing: ${criticalMissing.map((s) => s.id).join(", ")}`,
    );
    process.exitCode = 1;
  }
}

main();
