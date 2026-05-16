# Mutual Fund FAQ Assistant — Phase-Wise Architecture

> Companion to [PROBLEM_STATEMENT.md](PROBLEM_STATEMENT.md). This document is the build plan: decisions, system design, data contracts, and an ordered set of phases with acceptance criteria.

---

## 1. Locked Decisions

| Area | Decision | Why |
|---|---|---|
| **Data sources** | Official only — `hdfcfund.com` (HDFC AMC) + AMFI + SEBI + CAMS / MF Central | Brief bans aggregators; Groww is one. Groww is **UI inspiration only**, never a citation. |
| **LLM** | **Gemini 2.0 Flash** (answer synthesis + query classification) | Genuinely free tier; one vendor for generation *and* embeddings; ample for a guardrail-heavy, facts-only app. |
| **Embeddings** | Gemini `text-embedding-004` | Same vendor, free tier, no extra account. |
| **Retrieval store** | **In-memory static index** — embeddings baked into `index.json` at build time, cosine similarity in the API route | Corpus is ~15–25 pages (~150–300 chunks). Zero infra, zero cost, no cold-start. |
| **Architecture** | **Hybrid** — curated `facts.json` (deterministic) + RAG (open-ended) | Prevents the #1 failure mode: retrieving the *wrong scheme's* numbers. |
| **Framework / host** | Next.js (App Router, TypeScript) on Vercel free tier | Native Vercel fit; frontend + serverless API in one repo. |
| **Ingestion** | **Offline pipeline** — runnable locally *and* on a **GitHub Actions cron schedule** that opens a refresh PR | Reproducible corpus; no scraper in the request path; scheduled refresh keeps data current; the PR step keeps a human gate on numeric facts. |

### Scheme corpus (5 schemes, 5 SEBI categories)

| Official HDFC scheme | Category | (ex-name) |
|---|---|---|
| HDFC Mid-Cap Opportunities Fund | Mid Cap | — |
| HDFC Flexi Cap Fund | Flexi Cap | ex–HDFC Equity Fund |
| HDFC Focused Fund | Focused | ex–Focused 30 |
| HDFC ELSS Tax Saver | ELSS | ex–HDFC TaxSaver |
| HDFC Large Cap Fund | Large Cap | ex–HDFC Top 100 |

---

## 2. System Architecture

```
   OFFLINE PIPELINE        ┌─────────────────────────────────────────┐
   triggered by either:    │  scripts/  ─ 1-fetch → 2-extract →       │
   • local run             │            3-build-index → 4-build-facts│
   • GH Actions cron ────▶ └───────────────┬─────────────────────────┘
     (monthly)                            │ produces
                          corpus/sources.json · raw/ · index.json · facts.json
                                          │ cron run → opens refresh PR
                                          │ → human merges → Vercel redeploys
══════════════════════════════════════════╪══════════════════════════════════
   RUNTIME (Vercel)                        │ loaded at cold start
                                          ▼
  ┌────────┐   POST /api/ask    ┌───────────────────────────────────────────┐
  │  UI    │ ─────────────────▶ │  API route  app/api/ask/route.ts          │
  │ page   │                    │                                           │
  │ .tsx   │                    │  1. PII Guard      (regex, pre-LLM)        │
  │        │ ◀───────────────── │  2. Classifier     (rules + Gemini)       │
  └────────┘   {answer,         │  3. Router ──┬─ advisory  → Refusal       │
               citation,        │              ├─ out-of-scope → Scope msg  │
               lastUpdated}     │              └─ factual ──┐               │
                                │  4a. facts.json lookup ◀──┤ (deterministic)│
                                │  4b. RAG: embed → cosine  │ (fallback)    │
                                │      → top-k → Gemini synth│              │
                                │  5. Answer assembler (≤3 sentences,       │
                                │     1 citation, dated footer)             │
                                └───────────────────────────────────────────┘
```

### Query lifecycle (runtime)

1. **PII Guard** — regex scan for PAN / Aadhaar / phone / email / account no. / OTP. On hit: return a safe message, **process nothing, log nothing**.
2. **Classifier** — cheap rule pre-filter for advisory keywords (`should i`, `better`, `recommend`, `worth it`, `buy`, `sell`), then a Gemini call returns `factual | advisory | out_of_scope`.
3. **Router**
   - `advisory` → **Refusal handler**: polite facts-only message + an AMFI/SEBI educational link.
   - `out_of_scope` → polite "I can only answer facts about these 5 HDFC schemes."
   - `factual` → continue.
4. **Answer path (factual)**
   - **4a. Structured lookup** — detect `(scheme, fact-type)`; if matched, read the value + citation straight from `facts.json`. Deterministic, never hallucinated.
   - **4b. RAG fallback** — for open-ended queries ("how do I download my capital-gains statement?"): embed query → cosine similarity over `index.json` → top-k chunks → Gemini synthesizes a ≤3-sentence answer grounded *only* in those chunks.
5. **Answer assembler** — enforce ≤3 sentences, attach exactly one citation, append `Last updated from sources: <date>`.

---

## 3. Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14+ (App Router), TypeScript |
| UI | React + Tailwind CSS (single page) |
| LLM | Gemini 2.0 Flash via `@google/generative-ai` |
| Embeddings | Gemini `text-embedding-004` |
| HTML ingestion | `playwright` (JS-rendered pages) or `cheerio` (static) |
| PDF ingestion | `pdf-parse` (factsheets, SID, KIM are PDFs) |
| Retrieval | In-memory cosine similarity (no DB) |
| Hosting | Vercel (free tier) |
| Secrets | `GEMINI_API_KEY` in Vercel env vars + local `.env.local` |

---

## 4. Repository Layout

```
/
├── .github/
│   └── workflows/
│       └── refresh-corpus.yml  # scheduled (cron) ingestion → refresh PR
├── app/
│   ├── layout.tsx
│   ├── page.tsx                # Minimal UI: welcome, 3 examples, disclaimer
│   └── api/ask/route.ts        # Serverless endpoint
├── lib/
│   ├── pii-guard.ts            # regex PII detection
│   ├── classifier.ts           # rule pre-filter + Gemini intent
│   ├── facts.ts                # structured (scheme, fact-type) lookup
│   ├── retriever.ts            # cosine similarity over index.json
│   ├── gemini.ts               # LLM + embedding client wrapper
│   └── answer.ts               # assembly, ≤3-sentence + citation + footer
├── corpus/
│   ├── sources.json            # manifest of the 15–25 official URLs
│   ├── raw/                    # snapshotted HTML / PDF (reproducibility)
│   ├── index.json              # built artifact: embedded chunks
│   └── facts.json              # built artifact: curated structured facts
├── scripts/
│   ├── 1-fetch.ts              # download + snapshot sources
│   ├── 2-extract.ts            # HTML/PDF → clean text
│   ├── 3-build-index.ts        # chunk + embed → index.json
│   └── 4-build-facts.ts        # extract → facts.json (reviewed via PR)
│   └── (npm run ingest runs 1→4 in order)
├── data/prompts/               # system prompts (classifier, synthesis, refusal)
├── docs/
│   └── edge-cases.md           # consolidated edge-case catalogue (all phases, indexed by problem-statement commitment)
├── README.md
├── ARCHITECTURE.md
└── PROBLEM_STATEMENT.md
```

---

## 5. Data Contracts

**`corpus/sources.json`** — the manifest (one entry per URL):
```json
{
  "id": "hdfc-midcap-factsheet",
  "scheme": "HDFC Mid-Cap Opportunities Fund",
  "category": "Mid Cap",
  "type": "factsheet | scheme-page | sid | kim | faq | fees | riskometer | statement-guide | amfi | sebi",
  "url": "https://www.hdfcfund.com/...",
  "publisher": "HDFC AMC | AMFI | SEBI | CAMS",
  "fetchedAt": "2026-05-14",
  "localSnapshot": "corpus/raw/hdfc-midcap-factsheet.pdf"
}
```

**`corpus/facts.json`** — the deterministic fact layer:
```json
{
  "HDFC Mid-Cap Opportunities Fund": {
    "category": "Mid Cap",
    "expenseRatio": { "value": "...", "asOf": "...", "sourceId": "hdfc-midcap-factsheet" },
    "exitLoad":     { "value": "...", "asOf": "...", "sourceId": "..." },
    "minSIP":       { "value": "...", "asOf": "...", "sourceId": "..." },
    "lockIn":       { "value": "Not applicable", "sourceId": "..." },
    "riskometer":   { "value": "...", "asOf": "...", "sourceId": "..." },
    "benchmark":    { "value": "...", "asOf": "...", "sourceId": "..." }
  }
}
```

**`corpus/index.json`** — RAG chunks (built artifact):
```json
{
  "chunkId": "hdfc-faq-statements#003",
  "sourceId": "hdfc-faq-statements",
  "text": "To download a capital gains statement ...",
  "embedding": [0.013, -0.044, ...],
  "url": "https://www.hdfcfund.com/...",
  "fetchedAt": "2026-05-14"
}
```

**`POST /api/ask` response:**
```json
{
  "type": "answer | refusal | out_of_scope | pii_blocked",
  "answer": "string (≤ 3 sentences)",
  "citation": { "url": "https://...", "label": "HDFC AMC — Mid-Cap Factsheet" },
  "lastUpdated": "2026-05-14",
  "intent": "factual | advisory | out_of_scope"
}
```

---

## 6. Build Phases

> Sequential. Each phase has a concrete deliverable and an acceptance gate — don't start the next until the gate passes.
> Per-phase edge cases (what can go wrong + how to handle it) live in [docs/edge-cases.md](docs/edge-cases.md), indexed by the problem-statement commitments they put at risk.

### Phase 0 — Setup & Foundations
- **Tasks:** `create-next-app` (TS, App Router, Tailwind); init repo; create folder skeleton; get a Gemini API key; add `.env.local` + Vercel env var; connect repo to a Vercel project (empty deploy works).
- **Deliverable:** Bare app deploys to Vercel.
- **Gate:** `https://<project>.vercel.app` renders a placeholder page.

### Phase 1 — Corpus Definition & Source Verification
- **Tasks:** Verify the official `hdfcfund.com` URL for each of the 5 schemes (names changed over the years — confirm each). Identify factsheet / SID / KIM / FAQ / fees / riskometer / statement-guide pages + AMFI + SEBI + CAMS pages. Author `corpus/sources.json` with 15–25 entries.
- **Deliverable:** `sources.json` complete and reviewed.
- **Gate:** Every URL resolves, is official (AMC/AMFI/SEBI/CAMS), and covers all 6 fact types across all 5 schemes.

### Phase 2 — Offline Ingestion Pipeline
- **Tasks:** `1-fetch` snapshots each source into `corpus/raw/` (Playwright for JS pages, direct download for PDFs). `2-extract` converts HTML/PDF → clean text. `3-build-index` chunks (~500–800 tokens, slight overlap), embeds via `text-embedding-004`, writes `index.json`. `4-build-facts` extracts the 6 fact types per scheme into `facts.json` — **each value human-verified against its source PDF/page**.
- **Deliverable:** `raw/`, `index.json`, `facts.json` committed.
- **Gate:** `facts.json` has all 6 facts for all 5 schemes, each with a valid `sourceId`; spot-check 5 values against the source documents.

### Phase 3 — Retrieval & Answer Engine (API)
- **Tasks:** `pii-guard.ts` (regex, pre-LLM, no logging on hit). `classifier.ts` (rule pre-filter + Gemini intent). `facts.ts` (scheme + fact-type detection → `facts.json`). `retriever.ts` (cosine similarity, top-k). `gemini.ts` (client wrapper). `answer.ts` (≤3 sentences, one citation, dated footer; refusal + scope messages). Wire all into `app/api/ask/route.ts`.
- **Deliverable:** Working `/api/ask` endpoint.
- **Gate:** `curl` tests pass for one query of each type — factual (numeric), factual (open-ended/RAG), advisory, out-of-scope, PII.

### Phase 4 — Minimal UI
- **Tasks:** Single page — welcome line, 3 clickable example questions, the disclaimer **"Facts-only. No investment advice."**, an input box, and an answer card showing the answer + citation link + `Last updated from sources` footer. Loading and error states.
- **Deliverable:** Functional UI wired to `/api/ask`.
- **Gate:** All 3 example questions return correctly formatted, cited answers in the browser.

### Phase 5 — Guardrails, Testing & QA
- **Tasks:** Build a test matrix — (a) all 6 fact types × 5 schemes, (b) advisory refusals ("should I buy?", "which is better?"), (c) PII inputs (PAN/Aadhaar/phone/email/account/OTP), (d) out-of-scope ("weather?", a non-HDFC fund), (e) performance/returns queries → must redirect to factsheet, never compute. Verify every answer has exactly one valid citation and ≤3 sentences.
- **Deliverable:** Test results table in the README.
- **Gate:** 100% of refusal/PII cases handled; 0 wrong-scheme citations; 0 answers >3 sentences.

### Phase 6 — Deployment
- **Tasks:** Confirm `GEMINI_API_KEY` in Vercel; verify `index.json`/`facts.json` ship in the deployment bundle; production smoke test; check serverless function size/timeout limits.
- **Deliverable:** Live public URL.
- **Gate:** All Phase 5 tests pass against the production URL.

### Phase 7 — Scheduled Data Refresh (GitHub Actions)
- **Tasks:** Add `npm run ingest` (runs `1-fetch → 2-extract → 3-build-index → 4-build-facts`). Author `.github/workflows/refresh-corpus.yml` (see §7). Add `GEMINI_API_KEY` as a repo secret. Test via `workflow_dispatch` before relying on cron.
- **Deliverable:** Working scheduled workflow that opens a refresh PR.
- **Gate:** A manual run produces a PR with updated `corpus/` artifacts and bumped `fetchedAt` dates; merging it triggers a Vercel redeploy.

### Phase 8 — Documentation & Deliverables
- **Tasks:** README — setup steps, selected AMC + schemes, RAG architecture overview, the refresh workflow, known limitations. Disclaimer snippet. Link `PROBLEM_STATEMENT.md` + `ARCHITECTURE.md`.
- **Deliverable:** Complete README.
- **Gate:** A fresh clone can be set up and run from the README alone.

---

## 7. Scheduled Data Refresh (GitHub Actions)

The offline pipeline is the same code whether run locally or in CI. A cron workflow re-runs it and proposes the result as a **Pull Request** — never a direct push to `main`.

- **Triggers:** `schedule` cron + `workflow_dispatch` for manual/test runs. **Cadence deviation:** the original design was monthly (mirroring HDFC's factsheet publication); during Phase 7 this was changed to **weekdays at 09:00 IST (`30 3 * * 1-5` UTC)** at user request — faster scrape-break detection at the cost of more PRs to review. Run-in-place via the fixed `corpus/auto-refresh` branch + concurrency guard keeps the PR queue at one open PR rather than 5/week.
- **Flow:** checkout → install deps → install Chromium → `npm run ingest` → if `corpus/` changed, open a PR with the diff.
- **Human gate:** numeric facts (`facts.json`) are the highest-risk artifact. A maintainer reviews the PR diff before merging — a bad parse can't silently reach production. On merge to `main`, Vercel auto-redeploys.
- **Secrets:** `GEMINI_API_KEY` (repo secret) — needed for the embedding step in `3-build-index`.
- **Permissions:** workflow needs `contents: write` + `pull-requests: write`.

```yaml
# .github/workflows/refresh-corpus.yml
name: Refresh corpus
on:
  schedule:
    - cron: "0 3 1 * *"        # 03:00 UTC, 1st of each month
  workflow_dispatch: {}
permissions:
  contents: write
  pull-requests: write
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run ingest    # 1-fetch → 2-extract → 3-build-index → 4-build-facts
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: corpus/auto-refresh
          title: "chore: scheduled corpus refresh"
          commit-message: "chore: refresh corpus artifacts"
          body: "Automated monthly refresh. **Review the facts.json diff before merging.**"
          add-paths: corpus/
```

> **Note:** keep PR-for-everything to start. If you later want less friction, you can auto-commit the lower-risk RAG `index.json` directly and PR only `facts.json` — but the numeric facts should always stay behind a human review.

---

## 8. Risk Register

| Risk | Mitigation |
|---|---|
| Wrong scheme's numbers retrieved | Hybrid design — numeric facts come from deterministic `facts.json`, not RAG. |
| LLM hallucinates a value | Synthesis prompt is grounded strictly in retrieved chunks / facts; refuse if unsupported. |
| Citation doesn't match the answer | Every chunk & fact carries its `sourceId`/`url`; the assembler attaches the citation from the *used* source, never a guess. |
| Stale data | GitHub Actions cron re-runs ingestion monthly and opens a refresh PR; `fetchedAt` + `Last updated from sources` footer stay honest. |
| Automated parse silently corrupts a fact | The scheduler opens a **PR**, not a direct push — a maintainer reviews the `facts.json` diff before it reaches production. |
| JS-rendered pages / PDFs fail to parse | Playwright for HTML, `pdf-parse` for PDFs; `raw/` snapshots make extraction re-runnable. |
| PII reaches the LLM or logs | PII Guard runs first, before any LLM call or logging. |
| Advisory question slips through | Two-layer classifier (rules + Gemini); synthesis prompt also instructed to refuse advice. |
| Vercel bundle too large / function timeout | Corpus is tiny (~150–300 chunks); index loads in-memory at cold start, well within limits. |
| HDFC scheme renamed since the brief | Phase 1 explicitly verifies each official URL before ingestion. |

---

## 9. Known Limitations (carry into README)

- Corpus refreshes monthly via the scheduled GitHub Action — facts are current as of the last *merged* refresh PR, not real-time.
- Covers **5 HDFC schemes only**; any other fund returns an out-of-scope message.
- **No performance/returns** — by design; performance queries redirect to the official factsheet.
- Answers are limited to the **6 fact types** + statement/tax-document guidance present in the corpus.
- Free-tier Gemini rate limits may throttle under heavy concurrent use.
