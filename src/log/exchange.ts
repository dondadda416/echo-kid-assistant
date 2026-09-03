/**
 * One log row per turn — including error turns (spec §6, §12 T4d).
 *
 * This is the last thing the request path does. It must never throw into that
 * path: a logging failure is written to stderr and the child still gets her
 * answer.
 */

import type { ExchangeFlag, ExchangeRow, Store, TurnAudit } from '../types.ts';

/**
 * Derive the log flag from the audit, per the §7.5 decision table.
 *
 *   DISTRESS input                → distress
 *   any error text                → error
 *   SENSITIVE input               → redirected
 *   NOISE input                   → none
 *   OK + output PASS              → none
 *   OK + anything else            → gate_fail
 */
export function deriveFlag(audit: Pick<TurnAudit, 'inputVerdict' | 'outputVerdict' | 'error'>): ExchangeFlag {
  if (audit.inputVerdict === 'DISTRESS') return 'distress';
  if (audit.error) return 'error';
  if (audit.inputVerdict === 'SENSITIVE') return 'redirected';
  if (audit.inputVerdict === 'NOISE') return 'none';
  if (audit.inputVerdict === 'OK') {
    return audit.outputVerdict === 'PASS' ? 'none' : 'gate_fail';
  }
  // Unknown verdict: treat as an error so it shows up in the parent log.
  return 'error';
}

const VALID_FLAGS: ExchangeFlag[] = [
  'none',
  'redirected',
  'distress',
  'gate_fail',
  'error',
];

/**
 * Write one exchange. Returns true when the row was stored.
 *
 * Fills in the flag when the caller left it unset (or left it at the default
 * `none` while the audit says otherwise — under-reporting a flagged turn to
 * the parent page is worse than over-reporting).
 */
export async function logExchange(
  store: Store,
  row: ExchangeRow,
): Promise<boolean> {
  try {
    const audit = row.audit;
    const derived = deriveFlag(audit);
    const given = audit.flag;
    const flag: ExchangeFlag =
      !VALID_FLAGS.includes(given) || (given === 'none' && derived !== 'none')
        ? derived
        : given;

    await store.logExchange({
      ...row,
      audit: { ...audit, flag },
    });
    return true;
  } catch (err) {
    // Never propagate. A lost log line must not become a spoken error.
    console.error('logExchange: failed to write exchange', err);
    return false;
  }
}
