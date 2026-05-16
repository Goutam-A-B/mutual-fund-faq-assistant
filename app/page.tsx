"use client";

// Phase 4 — single-page UI for POST /api/ask. Material 3 tokens (see
// globals.css + tailwind.config.ts), with Groww's vibrant green seeded into
// the M3 palette and used as a decorative accent — not as a standalone
// design. The page intentionally renders four distinct response types
// (answer / refusal / out_of_scope / pii_blocked) so the user always sees
// what category of reply they got (edge 4.1).

import { useCallback, useMemo, useRef, useState } from "react";
import type { AskResponse, Citation } from "@/lib/contracts";

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const EXAMPLE_QUESTIONS = [
  "What is the expense ratio of HDFC Mid-Cap Opportunities Fund?",
  "How do I download my capital gains statement?",
  "What is the lock-in for HDFC ELSS Tax Saver?",
];

const DISCLAIMER = "Facts-only. No investment advice.";

type Phase = "idle" | "loading" | "loaded" | "error";

// ──────────────────────────────────────────────────────────────────────────
// Icons (inline SVG — no extra dependency)
// ──────────────────────────────────────────────────────────────────────────

function SendIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  );
}

function ExternalLinkIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function ShieldIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Small UI atoms
// ──────────────────────────────────────────────────────────────────────────

/** M3 assist chip — used for example questions. */
function ExampleChip({
  question,
  disabled,
  onPick,
}: {
  question: string;
  disabled: boolean;
  onPick: (q: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(question)}
      disabled={disabled}
      className="text-label-large group inline-flex w-full items-center justify-between gap-3 rounded-m3-md border border-outline-variant bg-surface-low px-4 py-3 text-left text-on-surface transition hover:border-primary hover:bg-primary-container/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 sm:rounded-m3-lg"
    >
      <span className="break-words">{question}</span>
      <span
        aria-hidden
        className="shrink-0 text-on-surface-variant transition group-hover:text-primary"
      >
        →
      </span>
    </button>
  );
}

/** M3 status chip — shows the response type inside the answer card. */
function StatusChip({
  tone,
  label,
}: {
  tone: "answer" | "advisory" | "out_of_scope" | "pii";
  label: string;
}) {
  const tones: Record<typeof tone, string> = {
    answer: "bg-primary-container text-on-primary-container",
    advisory: "bg-secondary-container text-on-secondary-container",
    out_of_scope: "bg-surface-high text-on-surface-variant",
    pii: "bg-error-container text-on-error-container",
  };
  return (
    <span
      className={`text-label-small inline-flex items-center gap-1.5 rounded-m3-xs px-2 py-1 uppercase tracking-wide ${tones[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Response card
// ──────────────────────────────────────────────────────────────────────────

function tonalSurfaceFor(type: AskResponse["type"]): {
  surface: string;
  chip: Parameters<typeof StatusChip>[0]["tone"];
  chipLabel: string;
} {
  switch (type) {
    case "answer":
      return { surface: "bg-surface-low", chip: "answer", chipLabel: "Answer" };
    case "refusal":
      return {
        surface: "bg-secondary-container/40",
        chip: "advisory",
        chipLabel: "Advisory refused",
      };
    case "out_of_scope":
      return { surface: "bg-surface-container", chip: "out_of_scope", chipLabel: "Out of scope" };
    case "pii_blocked":
      return { surface: "bg-error-container/60", chip: "pii", chipLabel: "Personal info" };
  }
}

function CitationBlock({ citation, lastUpdated }: { citation: Citation; lastUpdated: string | null }) {
  return (
    <div className="mt-5 flex flex-col gap-2 border-t border-outline-variant pt-4">
      <a
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-label-large group inline-flex items-start gap-2 text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <ExternalLinkIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="flex flex-col gap-0.5">
          <span>{citation.label}</span>
          <span className="text-label-small break-all font-normal text-on-surface-variant">
            {citation.url}
          </span>
        </span>
      </a>
      {lastUpdated ? (
        <p className="text-label-small text-on-surface-variant">
          Last updated from sources: {lastUpdated}
        </p>
      ) : null}
    </div>
  );
}

function ResponseCard({ response }: { response: AskResponse }) {
  const { surface, chip, chipLabel } = tonalSurfaceFor(response.type);
  return (
    <article
      className={`rounded-m3-lg ${surface} animate-fade-in p-5 shadow-m3-1 sm:rounded-m3-xl sm:p-6`}
      aria-live="polite"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <StatusChip tone={chip} label={chipLabel} />
      </div>
      <p className="text-body-large whitespace-pre-wrap break-words text-on-surface">
        {response.answer}
      </p>
      {response.citation ? (
        <CitationBlock citation={response.citation} lastUpdated={response.lastUpdated} />
      ) : null}
    </article>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-m3-lg bg-surface-low p-5 shadow-m3-1 sm:rounded-m3-xl sm:p-6">
      <div className="mb-3 h-4 w-24 animate-pulse rounded-m3-xs bg-surface-high" />
      <div className="space-y-2">
        <div className="h-4 w-full animate-pulse rounded-m3-xs bg-surface-high" />
        <div className="h-4 w-11/12 animate-pulse rounded-m3-xs bg-surface-high" />
        <div className="h-4 w-3/4 animate-pulse rounded-m3-xs bg-surface-high" />
      </div>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <article
      className="rounded-m3-lg bg-error-container/60 p-5 shadow-m3-1 sm:rounded-m3-xl sm:p-6"
      role="alert"
    >
      <StatusChip tone="pii" label="Couldn't reach the assistant" />
      <p className="text-body-medium mt-3 text-on-error-container">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-label-large mt-4 inline-flex items-center gap-2 rounded-m3-xl border border-error/60 px-4 py-2 text-on-error-container transition hover:bg-error/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
      >
        Try again
      </button>
    </article>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────

export default function Home() {
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastAsked = useRef<string>("");

  const isLoading = phase === "loading";

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isLoading) return; // edges 4.4, 4.8

      setQuestion(text);
      lastAsked.current = text;
      setPhase("loading");
      setResponse(null);
      setError(null);
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: text }),
        });
        if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
        const data = (await res.json()) as AskResponse;
        setResponse(data);
        setPhase("loaded");
      } catch (err) {
        setError((err as Error).message || "Network error");
        setPhase("error");
      }
    },
    [isLoading],
  );

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    ask(question);
  };

  const onRetry = () => ask(lastAsked.current || question);

  const buttonDisabled = useMemo(() => isLoading || question.trim().length === 0, [isLoading, question]);

  return (
    <main className="relative min-h-screen pb-16">
      {/* Top app bar (M3) — brand on the left, disclaimer chip on the right */}
      <header className="sticky top-0 z-10 border-b border-outline-variant bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <span
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: "var(--md-brand)" }}
              aria-hidden
            />
            <span className="text-title-medium text-on-surface">MF FAQ Assistant</span>
          </div>
          <span className="text-label-small inline-flex items-center gap-1.5 rounded-m3-xl border border-outline-variant bg-surface-low px-3 py-1 text-on-surface-variant">
            <ShieldIcon className="h-3.5 w-3.5 text-primary" />
            {DISCLAIMER}
          </span>
        </div>
      </header>

      {/* Hero */}
      <section className="hero-glow">
        <div className="mx-auto max-w-3xl px-4 pb-4 pt-10 sm:px-6 sm:pb-6 sm:pt-14">
          <h1 className="text-display-small text-on-background">
            Five HDFC schemes.
            <br />
            <span className="text-primary">One source</span> per answer.
          </h1>
          <p className="text-body-large mt-4 max-w-xl text-on-surface-variant">
            Ask factual questions about expense ratio, exit load, minimum SIP, lock-in,
            riskometer, benchmark, or how to download a statement. Every reply is verified
            against an official HDFC AMC, AMFI, or SEBI page.
          </p>
        </div>
      </section>

      {/* Example questions */}
      <section className="mx-auto max-w-3xl px-4 pb-2 sm:px-6">
        <p className="text-label-large mb-2 text-on-surface-variant">Try one of these</p>
        <div className="flex flex-col gap-2 sm:grid sm:grid-cols-1 md:grid-cols-3">
          {EXAMPLE_QUESTIONS.map((q) => (
            <ExampleChip key={q} question={q} disabled={isLoading} onPick={ask} />
          ))}
        </div>
      </section>

      {/* Input */}
      <section className="mx-auto max-w-3xl px-4 pb-4 pt-6 sm:px-6">
        <form
          onSubmit={onSubmit}
          className="flex items-center gap-2 rounded-m3-xl border border-outline bg-surface-lowest p-1.5 shadow-m3-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30"
        >
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a factual question…"
            aria-label="Question"
            className="text-body-large min-w-0 flex-1 bg-transparent px-3 py-2 text-on-surface outline-none placeholder:text-on-surface-variant"
            disabled={isLoading}
            autoComplete="off"
            spellCheck
          />
          <button
            type="submit"
            disabled={buttonDisabled}
            className="text-label-large inline-flex items-center gap-2 rounded-m3-xl bg-primary px-4 py-2.5 text-on-primary shadow-m3-1 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-surface-high disabled:text-on-surface-variant disabled:shadow-none"
            aria-label="Ask"
          >
            <span className="hidden sm:inline">Ask</span>
            <SendIcon className="h-4 w-4" />
          </button>
        </form>
      </section>

      {/* Response area */}
      <section className="mx-auto max-w-3xl px-4 sm:px-6">
        {phase === "loading" ? (
          <SkeletonCard />
        ) : phase === "error" ? (
          <ErrorCard message={error ?? "Something went wrong."} onRetry={onRetry} />
        ) : response ? (
          <ResponseCard response={response} />
        ) : (
          <p className="text-body-medium px-1 py-2 text-on-surface-variant">
            Answers appear here with the official source they came from.
          </p>
        )}
      </section>
    </main>
  );
}
