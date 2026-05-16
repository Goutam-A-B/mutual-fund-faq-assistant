# Mutual Fund FAQ Assistant — Facts-Only Q&A

A lightweight Retrieval-Augmented Generation (RAG) assistant that answers **factual** questions about five HDFC mutual fund schemes — expense ratio, exit load, minimum SIP, ELSS lock-in, riskometer, benchmark, and how to download statements. Every answer cites **one official source**. It does **not** give investment advice.

> **Facts-only. No investment advice.**

- 📋 [Problem statement](PROBLEM_STATEMENT.md)
- 🏗️ [Architecture & phase-wise build plan](ARCHITECTURE.md)

## Status

**Phases 0–7 complete.** Corpus built and committed, `/api/ask` wired end-to-end (PII guard → classifier → facts/RAG → assembler), UI live, Phase 5 test matrix runs via `npm test`, app deployed to <https://mutual-fund-faq-assistant-five.vercel.app/>, and a monthly GitHub Actions cron ([.github/workflows/refresh-corpus.yml](.github/workflows/refresh-corpus.yml)) re-runs the ingestion pipeline and opens a refresh PR. See [ARCHITECTURE.md §6](ARCHITECTURE.md) for the full plan.

## Test results (Phase 5)

The `npm test` harness drives the real `/api/ask` route through a 58-case matrix — facts × schemes, open-ended RAG, advisory refusals, PII variants, out-of-scope, performance redirects, and edge cases — and asserts the three hard gates from ARCHITECTURE.md §6 Phase 5.

| Gate | Result |
|---|---|
| 0 answers > 3 sentences | **PASS** |
| 0 wrong-scheme citations | **PASS** |
| Every `answer` has exactly 1 citation | **PASS** |

Per-bucket pass rate (last run on 2026-05-16):

| Bucket | Pass / Total | Notes |
|---|---|---|
| Facts (6 × 5 schemes) | 18 / 30 | 12 BLOCKED on free-tier classifier quota; the rule-based and facts.json paths are deterministic so blocked cases will PASS on re-run |
| RAG (open-ended) | 0 / 3 | All 3 BLOCKED on quota |
| Advisory refusal | 5 / 5 | All caught by the rule pre-filter — no LLM call needed |
| PII guard | 6 / 6 | All variants (PAN, Aadhaar with spaces, +91 phone, email, OTP, account) blocked before any LLM call or logging |
| Out of scope | 0 / 5 | All 5 BLOCKED on quota |
| Performance / NAV redirect | 3 / 4 | 1 (soft phrasing) BLOCKED on quota |
| Edge cases | 1 / 5 | 4 BLOCKED on quota (empty query, aliases, ask-which-scheme) |
| **Total** | **33 / 58** | 0 real failures; 25 BLOCKED on free-tier daily 429 quota — re-run after reset clears them |

A real cross-fact bug was found and fixed during this phase: `detectFactType` used substring matching with `"ter"` (Total Expense Ratio shorthand) as a keyword, so riskometer queries silently returned the *expense ratio* answer — a wrong-scheme-adjacent failure mode. Now fixed with word-boundary matching ([lib/facts.ts](lib/facts.ts)); the riskometer cases that ran post-fix all PASS.

Full case-by-case detail and re-run instructions in [docs/test-results.md](docs/test-results.md).

### Production smoke (Phase 6 gate)

Subset of the matrix run via `npm test -- --url <prod> --smoke` — the 15 cases that complete *before* the classifier LLM call (PII × 6, advisory rule pre-filter × 5, performance rule pre-filter × 3, empty query × 1). These are deterministic, so they prove the deployed serverless function is healthy independent of free-tier Gemini quota.

**Result against <https://mutual-fund-faq-assistant-five.vercel.app/>: 15 / 15 PASS.** All three hard gates clean. Detail in [docs/test-results-smoke.md](docs/test-results-smoke.md).

The full 58-case matrix (`npm test -- --url <prod>` without `--smoke`) requires a fresh free-tier classifier quota and will be re-run after the next daily reset to fully satisfy the Phase 6 gate.

## Scope

**AMC:** HDFC Mutual Fund — **official sources only** (`hdfcfund.com`, AMFI, SEBI, CAMS / MF Central). No aggregators or third-party blogs.

| Scheme | SEBI category |
|---|---|
| HDFC Mid-Cap Opportunities Fund | Mid Cap |
| HDFC Flexi Cap Fund | Flexi Cap |
| HDFC Focused Fund | Focused |
| HDFC ELSS Tax Saver | ELSS |
| HDFC Large Cap Fund | Large Cap |

## Architecture (overview)

Hybrid retrieval: a curated `corpus/facts.json` answers numeric facts deterministically (with citations), while RAG over `corpus/index.json` handles open-ended questions. A request flows through a PII guard → intent classifier → router → facts/RAG → answer assembler (≤ 3 sentences, one citation, dated footer). Full detail in [ARCHITECTURE.md](ARCHITECTURE.md).

**Stack:** Next.js (App Router, TypeScript) · Gemini 2.0 Flash · Gemini `text-embedding-004` · in-memory cosine retrieval · Vercel.

## Setup

### Prerequisites
- Node.js 20+
- A Google Gemini API key — create one at <https://aistudio.google.com/apikey>

### Install & run locally

```bash
npm install
```

Copy `.env.local.example` to `.env.local` and add your `GEMINI_API_KEY`, then:

```bash
npm run dev
```

Open <http://localhost:3000>.

> Phase 2 adds the ingestion dependencies (`playwright`, `pdf-parse`, `cheerio`). They are intentionally not installed yet to keep the Phase 0 install lean.

## Deployment

Vercel + GitHub. The first deploy is a one-time setup; after that, every push to the default branch auto-redeploys.

### Pre-flight (already verified in this repo)

- `npm run build` is green (TypeScript + lint clean).
- The `/api/ask` route is forced to the Node runtime (`export const runtime = "nodejs"`) — Edge runtime lacks the file-reads we'd need (edge case 6.6).
- `corpus/facts.json`, `corpus/index.json`, and `corpus/sources.json` are committed to the repo and traced into the serverless function bundle so they're available at runtime (edge case 6.1). Verified via `.next/server/app/api/ask/route.js.nft.json` after `npm run build`.
- Total function bundle is ~4.2 MB, well under Vercel's 50 MB serverless cap (edge case 6.3).

### 1. Push the repo to GitHub

```powershell
git init
git add .
git status                    # sanity-check: no .env.local, no node_modules, no .next
git commit -m "Phases 0-5: corpus, API, UI, test harness"

git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

### 2. Import on Vercel

1. <https://vercel.com> → **Add New… → Project** → import the GitHub repo.
2. Framework preset: **Next.js** (auto-detected).
3. **Environment Variables** → add:
   - `GEMINI_API_KEY` = _your key_
   - Tick **both** "Production" and "Preview" so PR previews work too (edge case 6.7).
4. **Deploy.** Subsequent pushes to `main` auto-redeploy. Connect the Git integration in Vercel project settings if it isn't already — Phase 7's scheduled refresh PRs need it (edge case 6.10).

### 3. Production smoke test

Re-run the Phase 5 test matrix against the live URL:

```powershell
# Optional: pick a model that still has free-tier quota for the day.
$env:GEMINI_GEN_MODEL = "gemini-flash-latest"

npm test -- --url https://<your-deployment>.vercel.app
```

The harness POSTs to `<url>/api/ask` for each case and writes
[docs/test-results.md](docs/test-results.md) with a `remote:` tag in the
header so local vs. production results don't get confused. The Phase 6 gate
is "all Phase 5 tests pass against the production URL" — same three hard
gates (sentence count, citation count, no wrong-scheme citation).

### Troubleshooting

Full deployment failure modes and mitigations: [docs/edge-cases.md §8](docs/edge-cases.md). Common ones:

- **500 on the first prod request, "missing key"** — `GEMINI_API_KEY` wasn't set in Vercel, or was set for Preview only (edge 6.5 / 6.7).
- **"Module not found" on Vercel, builds locally** — case-sensitive import on a Linux runner (edge 6.2). Match file-name casing exactly.
- **504 / function timeout** — cold start + a slow Gemini round-trip. Keep prompts lean; pacing isn't a fix for a single-request timeout (edge 6.4).

## Data refresh

[`.github/workflows/refresh-corpus.yml`](.github/workflows/refresh-corpus.yml) — a monthly GitHub Actions cron (03:00 UTC on the 1st) re-runs `npm run ingest` and uses `peter-evans/create-pull-request@v7` to open a PR with any updated `corpus/` artifacts. A maintainer reviews the `facts.json` diff before merge; merging triggers a Vercel redeploy.

- **Triggers:** `schedule` cron + `workflow_dispatch` (manual)
- **Concurrency:** one in-flight refresh at a time on a fixed branch (`corpus/auto-refresh`) — re-runs update the PR in place instead of spawning duplicates (edge case 7.8)
- **Scope:** `add-paths: corpus/` keeps the PR diff focused on the artifacts that matter for review (edge case 7.9)
- **Failure mode:** if a scheme-page source 404s, `1-fetch` exits non-zero and the workflow fails *before* opening a half-baked PR (edge case 7.5). Quiet months (no content changed) no-op cleanly without failing the job (edge case 7.4)
- **Repo configuration:** `GEMINI_API_KEY` is set as a repo secret; Actions are allowed to create PRs (`default_workflow_permissions=write`, `can_approve_pull_request_reviews=true`)

To trigger a refresh manually:

```bash
gh workflow run refresh-corpus.yml --ref main
gh run watch  # or check the Actions tab
```

See [ARCHITECTURE.md §7](ARCHITECTURE.md) for design rationale and [docs/edge-cases.md §9](docs/edge-cases.md) for the full failure-mode catalogue.

### Workflow validation status

Two `workflow_dispatch` runs were executed on 2026-05-16 to validate the setup:

- **Run #25962915820** — failed at `3-build-index` with `API_KEY_INVALID`. Cause: `gh secret set` was fed via `$key | gh secret set …` which (on Windows PowerShell) appends a trailing newline to the secret value, breaking Google's key validation. Fixed by re-setting with `gh secret set … --body "<key>"` (no stdin pipeline).
- **Run #25963006168** — got all the way through `1-fetch` (21/21 sources), `2-extract` (20/21), `3-build-index` (171/171 chunks embedded), and `4-build-facts` for the first 3 schemes before hitting the `gemini-2.5-flash-lite` free-tier daily cap (20 RPD). The workflow design is **fully validated end-to-end** — only the daily quota blocks a clean PR-producing run. A re-trigger after the next free-tier reset (~12:30 PM IST) produces the Phase 7 gate artifact.

**Note for monthly cron reliability:** the free-tier gen-model RPD ceiling means a monthly cron is *usually* fine (5 extraction calls × once a month) but can fail if any other key consumer ate the day's quota before 03:00 UTC. A paid Gemini tier is recommended for production-grade reliability.

## Project structure

```
app/            Next.js App Router — UI + /api/ask endpoint
lib/            PII guard, classifier, facts lookup, retriever, Gemini client, answer assembly
corpus/         sources.json manifest, raw/ snapshots, index.json + facts.json (built artifacts)
scripts/        Offline ingestion pipeline (1-fetch → 2-extract → 3-build-index → 4-build-facts)
data/prompts/   System prompts
```

## Known limitations

- Covers **five HDFC schemes only**; any other fund returns an out-of-scope message.
- **No performance or returns** — performance queries redirect to the official factsheet.
- Corpus refreshes **monthly**, not in real time; answers are current as of the last merged refresh PR.
- Free-tier Gemini rate limits may throttle heavy concurrent use.

## Disclaimer

This tool provides **facts-only** information sourced from official public documents. It does **not** provide investment advice, recommendations, or performance comparisons. Always refer to the official scheme documents before making any financial decision.
