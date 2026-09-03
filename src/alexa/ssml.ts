/**
 * SSML construction, escaping, sanitising and length trimming.
 *
 * Everything spoken to the child passes through here. This module never
 * *decides* whether text is safe — that is the output gate's job (§7.4). It
 * only makes already-approved text speakable and safe to embed in SSML.
 *
 * Safety notes:
 *  - `escapeSsml` must escape `&` FIRST, otherwise the entities produced for
 *    `<`, `>`, `"` and `'` would themselves be re-escaped and spoken literally.
 *  - `sanitizeForSpeech` strips only non-speakable decoration. It must not
 *    mangle ordinary apostrophes ("don't") or hyphens ("well-known"), which are
 *    normal English and are read correctly by Alexa.
 */

import { canned } from '../pipeline/canned.ts';

/**
 * Continuation offer. Re-exported from the canned-lines module so that every
 * string spoken to the child without passing the output gate lives in exactly
 * one reviewed file (src/pipeline/canned.ts). Do not inline it here.
 */
export const CONTINUE_OFFER = canned('CONTINUE_OFFER');

/**
 * Escape the five XML entities, ampersand first.
 */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Fenced code blocks, including an unterminated trailing fence.
const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;
// Inline markdown links: [text](target) -> text
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
// Bare URLs.
const URL_HTTP = /\b(?:https?|ftp):\/\/\S+/gi;
const URL_WWW = /\bwww\.[^\s]+/gi;
// Leftover markdown decoration. Deliberately excludes ' and -.
const MD_CHARS = /[*_#`~|]/g;
// Leftover square brackets from link syntax. Angle brackets are deliberately
// NOT stripped here — escapeSsml turns them into entities so they are spoken
// rather than silently swallowed.
const BRACKETS = /[[\]]/g;
// Emoji and pictographs, variation selectors, ZWJ, keycaps, flags.
const EMOJI =
  /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{FE00}-\u{FE0F}]|\u{200D}|\u{20E3}|[\u{2190}-\u{21FF}]|[\u{2B00}-\u{2BFF}]/gu;

/**
 * Strip everything that should never be read aloud, then collapse whitespace.
 */
export function sanitizeForSpeech(text: string): string {
  let out = text;
  out = out.replace(CODE_FENCE, ' ');
  out = out.replace(MD_LINK, '$1');
  out = out.replace(URL_HTTP, ' ');
  out = out.replace(URL_WWW, ' ');
  out = out.replace(EMOJI, ' ');
  out = out.replace(MD_CHARS, '');
  out = out.replace(BRACKETS, ' ');
  // Markdown bullet / heading leaders left at the start of a line.
  out = out.replace(/^[ \t]*[-+•]\s+/gm, '');
  out = out.replace(/\s+/g, ' ');
  // Tidy space introduced before punctuation by the strips above.
  out = out.replace(/\s+([,.!?;:])/g, '$1');
  return out.trim();
}

export interface TrimResult {
  /** The part to speak now. Never ends mid-word. */
  spoken: string;
  /** What was left over, verbatim. Empty string when nothing was cut. */
  remainder: string;
}

/**
 * Cut `text` at the last sentence boundary that keeps the spoken part within
 * `maxChars`. Falls back to the last word boundary; never splits a word.
 */
export function trimToSentence(text: string, maxChars: number): TrimResult {
  const t = text.trim();
  if (maxChars <= 0) return { spoken: '', remainder: t };
  if (t.length <= maxChars) return { spoken: t, remainder: '' };

  // Last '.', '!' or '?' followed by whitespace or end-of-string, whose
  // inclusive slice still fits inside maxChars.
  let best = -1;
  const limit = Math.min(t.length, maxChars);
  for (let i = 0; i < limit; i++) {
    const c = t[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;
    const next = t[i + 1];
    if (next === undefined || /\s/.test(next)) best = i;
  }
  if (best >= 0) {
    return {
      spoken: t.slice(0, best + 1).trim(),
      remainder: t.slice(best + 1).trim(),
    };
  }

  // No sentence boundary fits — fall back to a word boundary. Look one char
  // past the cap so a space sitting exactly at maxChars still counts.
  const window = t.slice(0, maxChars + 1);
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) {
    return {
      spoken: t.slice(0, lastSpace).trim(),
      remainder: t.slice(lastSpace).trim(),
    };
  }

  // A single word longer than the cap: speak the whole word rather than
  // splitting it. Length may exceed maxChars; that is the lesser evil.
  const firstSpace = t.indexOf(' ');
  if (firstSpace === -1) return { spoken: t, remainder: '' };
  return { spoken: t.slice(0, firstSpace).trim(), remainder: t.slice(firstSpace).trim() };
}

/** Anything that can be turned into speech: a plain string or a pipeline result. */
export interface SpeakableResult {
  speech: string;
}

/**
 * Sanitize -> escape -> wrap in <speak>. The single place SSML is built.
 */
export function buildSpeech(result: string | SpeakableResult): string {
  const raw = typeof result === 'string' ? result : result.speech;
  return `<speak>${escapeSsml(sanitizeForSpeech(raw))}</speak>`;
}
