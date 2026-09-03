/**
 * Long-term memory: topics and preferences only (spec §6).
 *
 * Runs AFTER the response has been sent. Nothing here may delay or break the
 * request path, so every entry point catches its own errors and resolves to a
 * no-op result.
 *
 * Defence in depth:
 *   1. the extraction prompt forbids anything identifying;
 *   2. every candidate line goes through `scrubLine` — a deterministic check
 *      that does not trust the model;
 *   3. the turn is skipped entirely when the deterministic PII scan fired or
 *      the turn was flagged.
 */

import type { ExchangeRow, Store } from '../types.js';
import { scrubLine } from './scrub.js';
import { MEMORY_LINE_CAP } from './db.js';

/** Most new lines a single turn may contribute. */
export const MAX_NEW_LINES = 2;

/** Longest a stored line may be. */
export const MAX_LINE_CHARS = 80;

/** A fast-model call. Returns the raw completion text. */
export type MemoryModelCall = (args: {
  system: string;
  user: string;
}) => Promise<string>;

export const MEMORY_SYSTEM_PROMPT = [
  'You maintain a tiny list of topics and preferences for a voice assistant',
  'that talks with one child. You will see one exchange.',
  '',
  'Output at most two very short lines, each describing a TOPIC SHE ENJOYS or',
  'SOMETHING SHE IS PRACTISING. Examples of the only acceptable style:',
  '  likes stories about horses',
  '  practicing subtraction with borrowing',
  '  curious about volcanoes',
  '  enjoys knock-knock jokes',
  '',
  'Output NOTHING IDENTIFYING. Never write: any name (hers, family, friends,',
  'teachers, pets, characters she says are real people), school, class, grade,',
  'teacher, town, city, address, street, phone number, birthday, age, dates,',
  'days of the week, schedule, when she is home or alone, where her parents',
  'are, health or medical details, or any family detail.',
  '',
  'Never quote her words. Never write a full sentence about her life. If the',
  'exchange contains nothing that fits, or anything is borderline, reply with',
  'exactly: NONE',
  '',
  'Reply with the lines only, one per line, no bullets, no punctuation at the',
  'end, no explanation.',
].join('\n');

function buildUserMessage(exchange: ExchangeRow, existing: readonly string[]): string {
  const known = existing.length > 0 ? existing.join('\n') : '(none yet)';
  return [
    'Already known (do not repeat these):',
    known,
    '',
    'This exchange:',
    `CHILD: ${exchange.utterance}`,
    `ASSISTANT: ${exchange.spoken}`,
  ].join('\n');
}

/** True when this turn must not contribute memory at all. */
export function shouldSkipExtraction(exchange: ExchangeRow): boolean {
  const a = exchange.audit;
  if (!a) return true;
  if (a.containsPII === true) return true;
  if (a.flag !== 'none') return true;
  if (a.inputVerdict !== 'OK') return true;
  if (a.outputVerdict !== 'PASS') return true;
  if (!exchange.utterance || !exchange.spoken) return true;
  return false;
}

/** Split a model completion into candidate lines. */
export function parseModelLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•\d.)\s]+/, '').trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^none\.?$/i.test(l))
    .slice(0, 8);
}

/**
 * Extract at most two new memory lines from one turn.
 *
 * Never throws and never rejects: any model error, malformed output, or
 * unexpected exception resolves to an empty array.
 */
export async function extractMemory(
  exchange: ExchangeRow,
  existingLines: readonly string[],
  callModel: MemoryModelCall,
): Promise<string[]> {
  try {
    if (shouldSkipExtraction(exchange)) return [];

    const raw = await callModel({
      system: MEMORY_SYSTEM_PROMPT,
      user: buildUserMessage(exchange, existingLines),
    });
    if (typeof raw !== 'string' || raw.trim().length === 0) return [];

    const known = new Set(existingLines.map((l) => l.trim().toLowerCase()));
    const out: string[] = [];

    for (const candidate of parseModelLines(raw)) {
      if (out.length >= MAX_NEW_LINES) break;
      if (candidate.length > MAX_LINE_CHARS) continue;
      // Deterministic second check. The model is not trusted.
      const clean = scrubLine(candidate);
      if (clean === null) continue;
      if (clean.length > MAX_LINE_CHARS) continue;
      const key = clean.toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      out.push(clean);
    }
    return out;
  } catch (err) {
    console.error('extractMemory: dropped turn', err);
    return [];
  }
}

/** Merge new lines onto existing ones, keeping at most MEMORY_LINE_CAP, oldest dropped first. */
export function mergeMemory(
  existing: readonly string[],
  added: readonly string[],
): string[] {
  const merged = [...existing, ...added];
  return merged.slice(Math.max(0, merged.length - MEMORY_LINE_CAP));
}

/**
 * Fire-and-forget entry point. The caller does:
 *
 *     void updateMemoryAfterResponse(store, exchange, callModel);
 *
 * It awaits nothing on the request path and can never reject.
 */
export async function updateMemoryAfterResponse(
  store: Store,
  exchange: ExchangeRow,
  callModel: MemoryModelCall,
): Promise<string[]> {
  try {
    if (shouldSkipExtraction(exchange)) return [];
    const existing = await store.loadMemory(exchange.userId);
    const added = await extractMemory(exchange, existing, callModel);
    if (added.length === 0) return existing;
    const merged = mergeMemory(existing, added);
    await store.replaceMemory(exchange.userId, merged);
    return merged;
  } catch (err) {
    console.error('updateMemoryAfterResponse: failed', err);
    return [];
  }
}
