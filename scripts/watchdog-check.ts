/**
 * Daily logging-health check (task T8) — the durable half of the watchdog.
 *
 * The in-process counter in src/log/watchdog.ts is fast but per-instance: it
 * resets on every serverless cold start and cannot see what other instances
 * did. This script asks the database itself, so it sees the whole day across
 * every instance. Run by .github/workflows/watchdog.yml.
 *
 * Two questions, both about the same failure mode — the assistant talking
 * while the parent transcript records nothing:
 *
 *   1. Orphan sessions: a session started in the last 24h with turn_count > 0
 *      and zero rows in `exchanges` for its session_id. Turns happened; none
 *      were written.
 *   2. Total silence: zero exchanges in the last 24h while sessions with turns
 *      exist. This catches the case where every session is an orphan, which
 *      check 1 also catches, and the case where session rows themselves are
 *      the only thing landing.
 *
 * EXIT CODES ARE DELIBERATE.
 *   0 — the check ran. Findings or no findings.
 *   1 — the database was unreachable, so nothing was checked.
 * A green run therefore means "checked", not "no data". Making a detected
 * outage red would put a red X on the repo every morning of an outage, and a
 * red X every morning is a thing people learn to ignore. The alert is the
 * signal; CI is only the thing that guarantees the question got asked.
 *
 * PRIVACY: this script selects ids, counts and timestamps. It must never
 * SELECT `utterance`, `spoken` or `generation_text` — those exist only for the
 * password-protected parent page (SPEC §2.4, PHASE-2 rule 4).
 */

import { sendAlert } from '../src/log/alert.js';

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

/**
 * Same dynamic-import pattern as `getStore()` in src/memory/db.ts: the driver
 * must not be a static import anywhere the unit-test module graph can reach.
 */
async function connect(url: string): Promise<Sql> {
  const mod = await import('@neondatabase/serverless');
  return mod.neon(url) as unknown as Sql;
}

interface Orphan {
  sessionId: string;
  turnCount: number;
  startedAt: string;
}

function summarize(
  orphans: Orphan[],
  exchanges24h: number,
  sessionsWithTurns24h: number,
): { subject: string; body: string } | null {
  const totalSilence = exchanges24h === 0 && sessionsWithTurns24h > 0;
  if (orphans.length === 0 && !totalSilence) return null;

  const lines: string[] = [
    'The parent transcript is missing turns that were spoken.',
    '',
    `window: last 24 hours (checked ${new Date().toISOString()})`,
    `sessions with turns: ${sessionsWithTurns24h}`,
    `exchange rows written: ${exchanges24h}`,
    `sessions with turns but no rows: ${orphans.length}`,
  ];

  if (totalSilence) {
    lines.push(
      '',
      'NOTHING was written in the last 24 hours while sessions recorded turns.',
    );
  }

  if (orphans.length > 0) {
    lines.push('', 'affected sessions (id, turns, started):');
    for (const o of orphans.slice(0, 50)) {
      lines.push(`  ${o.sessionId}  turns=${o.turnCount}  ${o.startedAt}`);
    }
    if (orphans.length > 50) {
      lines.push(`  … and ${orphans.length - 50} more`);
    }
  }

  lines.push(
    '',
    'Check DATABASE_URL in Vercel, then confirm new rows appear on the',
    'parent page. Turn content is not included here by design.',
  );

  const subject =
    orphans.length > 0
      ? `Helper: ${orphans.length} session(s) logged no turns in 24h`
      : 'Helper: no turns were logged in the last 24h';

  return { subject, body: lines.join('\n') };
}

async function main(): Promise<number> {
  const url = process.env['DATABASE_URL']?.trim();
  if (!url) {
    console.error('[watchdog] DATABASE_URL is not set; nothing was checked.');
    return 1;
  }

  let sql: Sql;
  let orphanRows: Record<string, unknown>[];
  let exchangeRows: Record<string, unknown>[];
  let sessionRows: Record<string, unknown>[];
  try {
    sql = await connect(url);

    orphanRows = await sql`
      SELECT s.session_id, s.turn_count, s.started_at
      FROM sessions s
      WHERE s.started_at >= now() - interval '24 hours'
        AND s.turn_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM exchanges e WHERE e.session_id = s.session_id
        )
      ORDER BY s.started_at DESC`;

    exchangeRows = await sql`
      SELECT count(*)::int AS n FROM exchanges
      WHERE created_at >= now() - interval '24 hours'`;

    sessionRows = await sql`
      SELECT count(*)::int AS n FROM sessions
      WHERE started_at >= now() - interval '24 hours' AND turn_count > 0`;
  } catch (err) {
    // Unreachable database: the check did NOT run. This is the one red case.
    console.error(
      '[watchdog] database unreachable:',
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  }

  const orphans: Orphan[] = orphanRows.map((r) => ({
    sessionId: String(r['session_id'] ?? ''),
    turnCount: Number(r['turn_count'] ?? 0),
    startedAt: String(r['started_at'] ?? ''),
  }));
  const exchanges24h = Number(exchangeRows[0]?.['n'] ?? 0);
  const sessionsWithTurns24h = Number(sessionRows[0]?.['n'] ?? 0);

  const alert = summarize(orphans, exchanges24h, sessionsWithTurns24h);

  if (alert) {
    await sendAlert(alert.subject, alert.body);
    console.log(
      `[watchdog] PROBLEM: ${orphans.length} orphan session(s), ` +
        `${exchanges24h} exchange row(s), ${sessionsWithTurns24h} session(s) ` +
        'with turns in the last 24h. Alert sent.',
    );
  } else {
    console.log(
      `[watchdog] OK: ${exchanges24h} exchange row(s) and ` +
        `${sessionsWithTurns24h} session(s) with turns in the last 24h, ` +
        'no orphans.',
    );
  }

  // Findings are alerted, not failed. See the header.
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('[watchdog] unexpected failure:', err);
    process.exitCode = 1;
  },
);
