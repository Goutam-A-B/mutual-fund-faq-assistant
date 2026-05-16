# Mutual Fund FAQ Assistant — Facts-Only Q&A

> **Milestone Brief — Problem Statement**

---

## 1. Overview

Build a small, trustworthy **FAQ assistant** that answers **factual questions** about mutual fund schemes — for example, expense ratio, exit load, minimum SIP, ELSS lock-in, riskometer, benchmark index, and how to download statements.

The assistant retrieves information **exclusively from official public sources** (AMC websites, AMFI, SEBI) and **never provides investment advice, opinions, or recommendations**. Every answer includes exactly **one source link**, and the system strictly enforces constraints around clarity, accuracy, privacy, and compliance.

**Reference product context:** Groww.

---

## 2. Objective

Design and implement a lightweight **Retrieval-Augmented Generation (RAG)** assistant that:

- Answers **objective, verifiable** queries about mutual fund schemes.
- Draws answers from a **curated corpus of official documents**.
- Returns **concise, source-backed** responses.
- **Refuses** opinionated, advisory, or portfolio questions.

> **Guiding principle:** Prioritize *accuracy and transparency* over *intelligence*. The assistant should be trustworthy and compliant — not clever.

---

## 3. Who This Helps

| User | Need |
|------|------|
| **Retail investors** | Comparing mutual fund schemes on factual parameters. |
| **Support & content teams** | Answering repetitive, factual mutual fund questions consistently. |

---

## 4. Scope of Work

### 4.1 Corpus Definition

- Select **one AMC** (Asset Management Company).
- Choose **3–5 mutual fund schemes** with **category diversity** — e.g., one large-cap, one flexi-cap, one ELSS.
- Collect **15–25 official public URLs**, drawn from:
  - Scheme **factsheets**
  - **KIM** (Key Information Memorandum)
  - **SID** (Scheme Information Document)
  - AMC **FAQ / help / fee & charges** pages
  - **Riskometer / benchmark** notes
  - **AMFI / SEBI** guidance pages
  - **Statement & tax-document** download guides

### 4.2 FAQ Assistant Requirements

The assistant **must answer facts-only queries**, such as:

- "What is the expense ratio of *\<scheme\>*?"
- "What is the exit load for *\<scheme\>*?"
- "What is the minimum SIP amount?"
- "What is the ELSS lock-in period?"
- "What is the riskometer classification?"
- "What is the benchmark index?"
- "How do I download a capital-gains / account statement?"

Every answer **must**:

- ✅ Be **≤ 3 sentences**.
- ✅ Include **exactly one citation link** to an official source.
- ✅ Include the footer: **`Last updated from sources: <date>`**

### 4.3 Refusal Handling

The assistant **must refuse** non-factual, opinionated, or advisory queries, such as:

- "Should I invest in this fund?"
- "Should I buy / sell?"
- "Which fund is better?"

Refusal responses **must**:

- Be **polite and clearly worded**.
- **Reinforce the facts-only limitation**.
- Provide a **relevant educational link** (e.g., an AMFI or SEBI investor-education resource).

### 4.4 Minimal User Interface

A simple interface that includes:

- A **welcome message**.
- **Three example questions**.
- A visible disclaimer: **"Facts-only. No investment advice."**

---

## 5. Constraints

### 5.1 Data & Sources

- Use **only official public sources** — AMC, AMFI, SEBI.
- **Do not** use third-party blogs, aggregators, or app back-end screenshots as sources.

### 5.2 Privacy & Security — No PII

Do **not** accept, store, or process:

- PAN or Aadhaar numbers
- Account numbers
- OTPs
- Email addresses or phone numbers

### 5.3 Content Restrictions

- **No** investment advice or recommendations.
- **No** performance claims, return calculations, or scheme-vs-scheme comparisons.
- For performance-related queries, **link to the official factsheet only**.

### 5.4 Transparency

- Responses must be **short, factual, and verifiable**.
- Every answer carries a **source link** and a **last-updated date**.

---

## 6. Expected Deliverables

1. **README Document**, covering:
   - Setup instructions.
   - Selected AMC and schemes.
   - Architecture overview (RAG approach).
   - Known limitations.
2. **Working Prototype** — the FAQ assistant with its minimal UI.
3. **Curated Corpus** — the 15–25 official source URLs.
4. **Disclaimer Snippet** — *"Facts-only. No investment advice."*

---

## 7. Success Criteria

- ✅ Accurate retrieval of factual mutual fund information.
- ✅ Strict adherence to **facts-only** responses (≤ 3 sentences).
- ✅ Consistent inclusion of **valid source citations** and last-updated dates.
- ✅ Proper **refusal** of advisory or opinionated queries, with an educational link.
- ✅ Clean, minimal, user-friendly interface with a visible disclaimer.
- ✅ Zero PII collected or stored.

---

## 8. Summary

The goal is a **trustworthy, transparent, and compliant** mutual fund FAQ assistant that **prioritizes accuracy over intelligence**. Users should receive only **verified, source-backed** factual information — with **no advisory bias and no speculative content** — and every answer should be traceable to a single official public source.
