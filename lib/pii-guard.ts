// Phase 3 — PII guard. Runs FIRST in the pipeline, before any LLM call and
// before any logging (edge case 3.5). On a hit we return *only* the PII type
// so the route can craft a safe response — the matched value never leaves
// this function and is never written anywhere.

export type PIIType = "pan" | "aadhaar" | "phone" | "email" | "otp" | "account";

export interface PIICheck {
  hit: boolean;
  type?: PIIType;
}

// PAN: 5 letters, 4 digits, 1 letter (Income Tax format).
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/i;
// Aadhaar: 12 digits, optionally grouped 4-4-4 by space or hyphen.
const AADHAAR_RE = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;
// Indian phone: optional +91 / 0 prefix, leading 6-9 (TRAI numbering).
const PHONE_RE = /(?:\+?91[\s-]?|\b0)?[6-9]\d{9}\b/;
// Standard-enough email pattern.
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
// OTP: the word itself is treated as PII — if a user types "my otp is …" we
// stop before they paste it. Conservative on purpose.
const OTP_RE = /\botp\b/i;
// Account-number heuristic: the word "account" or "A/c" near a 6+ digit run.
const ACCOUNT_RE = /\baccount\b[^\d\n]{0,30}\d{6,}|\bA\/?[Cc]\b[^\d\n]{0,15}\d{6,}/;

/**
 * Returns the first PII type that matches anywhere in `text`. Order matters:
 * we check the *most specific* shapes (PAN, Aadhaar) first so a 10-digit PAN
 * isn't mis-attributed as a phone number.
 */
export function checkPII(text: string): PIICheck {
  if (PAN_RE.test(text)) return { hit: true, type: "pan" };
  if (AADHAAR_RE.test(text)) return { hit: true, type: "aadhaar" };
  if (EMAIL_RE.test(text)) return { hit: true, type: "email" };
  if (PHONE_RE.test(text)) return { hit: true, type: "phone" };
  if (OTP_RE.test(text)) return { hit: true, type: "otp" };
  if (ACCOUNT_RE.test(text)) return { hit: true, type: "account" };
  return { hit: false };
}
