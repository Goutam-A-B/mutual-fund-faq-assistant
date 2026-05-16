// One-shot Gemini sanity probe. Throwaway debug helper for Phase 5.
// Iterates a small list of candidate models so we can see which (if any) still
// have free-tier quota right now.
import { loadEnv } from "./_shared";

const CANDIDATES = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-flash-latest",
];

async function probe(model: string, key: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: 'Respond with the JSON {"ok":true}.' }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    }),
  });
  if (res.ok) return "OK";
  const text = await res.text().catch(() => "");
  return `HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}`;
}

async function main() {
  loadEnv();
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("GEMINI_API_KEY missing");
    process.exit(1);
  }
  for (const m of CANDIDATES) {
    process.stdout.write(`${m.padEnd(28)} `);
    try {
      console.log(await probe(m, key));
    } catch (err) {
      console.log(`THREW: ${(err as Error).message}`);
    }
  }
}
void main();
