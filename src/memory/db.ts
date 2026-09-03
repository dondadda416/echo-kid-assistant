/**
 * Storage. Two implementations of the same `Store` contract:
 *
 *   getStore()            → Neon Postgres, reading DATABASE_URL.
 *   createInMemoryStore() → process-local, used by unit tests and the
 *                           red-team runner. Same semantics, same test suite.
 *
 * `ReviewStore` adds the read-only queries the parent page (§10) needs. Both
 * implementations provide it; the pipeline only ever sees `Store`.
 *
 * Nothing in here throws into the request path on a read: callers that must
 * not fail (history, memory) get empty results on error. Writes surface their
 * error to the caller — src/log/exchange.ts is the one that swallows it.
 */

import type {
  ConversationTurn,
  ExchangeFlag,
  ExchangeRow,
  InputReason,
  InputVerdict,
  MemoryLine,
  OutputVerdict,
  SessionRow,
  Store,
  TurnAudit,
} from '../types.ts';

/** Hard ceiling on stored memory lines (spec §6). */
export const MEMORY_LINE_CAP = 20;

/** A logged exchange as the parent page reads it back. */
export interface StoredExchange extends ExchangeRow {
  id: number;
  createdAt: Date;
}

/** Per-session flag tallies for the sessions list. */
export interface SessionSummary extends SessionRow {
  flagCounts: Record<ExchangeFlag, number>;
}

/** Read-only queries used by the parent review page. */
export interface ReviewStore extends Store {
  /** Flagged exchanges (flag <> 'none') from the last `days` days, newest first. */
  listFlagged(days: number, limit?: number): Promise<StoredExchange[]>;
  /** Sessions newest first, with flag tallies. */
  listSessions(limit?: number): Promise<SessionSummary[]>;
  /** Every exchange in one session, oldest first. */
  loadTranscript(sessionId: string): Promise<StoredExchange[]>;
  /** All memory lines with ids, oldest first. */
  listAllMemory(): Promise<MemoryLine[]>;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ZERO_TIMINGS = {
  inputGateMs: 0,
  generationMs: 0,
  outputGateMs: 0,
  totalMs: 0,
};

const FLAGS: ExchangeFlag[] = [
  'none',
  'redirected',
  'distress',
  'gate_fail',
  'error',
];

function emptyFlagCounts(): Record<ExchangeFlag, number> {
  return { none: 0, redirected: 0, distress: 0, gate_fail: 0, error: 0 };
}

function asFlag(v: unknown): ExchangeFlag {
  return FLAGS.includes(v as ExchangeFlag) ? (v as ExchangeFlag) : 'none';
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Deep-copy an audit, filling in anything a row is missing. */
function normalizeAudit(a: Partial<TurnAudit> | undefined): TurnAudit {
  return {
    inputVerdict: (a?.inputVerdict ?? 'SENSITIVE') as InputVerdict,
    inputReason: (a?.inputReason ?? 'clean') as InputReason,
    inputRaw: a?.inputRaw ?? null,
    generationText: a?.generationText ?? null,
    outputVerdict: (a?.outputVerdict ?? null) as OutputVerdict | null,
    outputRaw: a?.outputRaw ?? null,
    flag: asFlag(a?.flag),
    containsPII: a?.containsPII === true,
    timings: { ...ZERO_TIMINGS, ...(a?.timings ?? {}) },
    models: { gate: a?.models?.gate ?? '', generation: a?.models?.generation ?? '' },
    error: a?.error ?? null,
  };
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export function createInMemoryStore(): ReviewStore {
  const sessions = new Map<string, SessionRow>();
  const exchanges: StoredExchange[] = [];
  const memory: MemoryLine[] = [];
  let exchangeSeq = 0;
  let memorySeq = 0;

  async function loadSession(sessionId: string): Promise<SessionRow | null> {
    const s = sessions.get(sessionId);
    return s ? { ...s } : null;
  }

  return {
    loadSession,

    async startSession(sessionId, userId) {
      const existing = sessions.get(sessionId);
      if (existing) return { ...existing };
      const row: SessionRow = {
        sessionId,
        userId,
        startedAt: new Date(),
        endedAt: null,
        turnCount: 0,
        capHit: false,
      };
      sessions.set(sessionId, row);
      return { ...row };
    },

    async bumpTurn(sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.turnCount += 1;
    },

    async endSession(sessionId, capHit) {
      const s = sessions.get(sessionId);
      if (s) {
        s.endedAt = new Date();
        s.capHit = s.capHit || capHit;
      }
    },

    async loadHistory(sessionId, limit) {
      const rows = exchanges.filter(
        (e) => e.sessionId === sessionId && e.audit.flag === 'none',
      );
      const turns: ConversationTurn[] = [];
      for (const r of rows) {
        turns.push({ role: 'user', content: r.utterance });
        turns.push({ role: 'assistant', content: r.spoken });
      }
      const n = Math.max(0, limit) * 2;
      return turns.slice(Math.max(0, turns.length - n));
    },

    async loadMemory(userId) {
      return memory.filter((m) => m.userId === userId).map((m) => m.line);
    },

    async replaceMemory(userId, lines) {
      for (let i = memory.length - 1; i >= 0; i--) {
        if (memory[i]!.userId === userId) memory.splice(i, 1);
      }
      const capped = lines.slice(Math.max(0, lines.length - MEMORY_LINE_CAP));
      for (const line of capped) {
        memory.push({
          id: ++memorySeq,
          userId,
          line,
          createdAt: new Date(),
        });
      }
    },

    async deleteMemoryLine(userId, id) {
      const i = memory.findIndex((m) => m.userId === userId && m.id === id);
      if (i >= 0) memory.splice(i, 1);
    },

    async logExchange(row) {
      exchanges.push({
        id: ++exchangeSeq,
        createdAt: row.createdAt ?? new Date(),
        sessionId: row.sessionId,
        userId: row.userId,
        utterance: row.utterance,
        spoken: row.spoken,
        cannedId: row.cannedId,
        audit: normalizeAudit(clone(row.audit)),
      });
    },

    async listFlagged(days, limit = 200) {
      const cutoff = Date.now() - days * 86_400_000;
      return exchanges
        .filter((e) => e.audit.flag !== 'none' && e.createdAt.getTime() >= cutoff)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((e) => ({ ...e, audit: clone(e.audit) }));
    },

    async listSessions(limit = 50) {
      const counts = new Map<string, Record<ExchangeFlag, number>>();
      for (const e of exchanges) {
        let c = counts.get(e.sessionId);
        if (!c) {
          c = emptyFlagCounts();
          counts.set(e.sessionId, c);
        }
        c[e.audit.flag] += 1;
      }
      return [...sessions.values()]
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, limit)
        .map((s) => ({
          ...s,
          flagCounts: counts.get(s.sessionId) ?? emptyFlagCounts(),
        }));
    },

    async loadTranscript(sessionId) {
      return exchanges
        .filter((e) => e.sessionId === sessionId)
        .sort((a, b) => a.id - b.id)
        .map((e) => ({ ...e, audit: clone(e.audit) }));
    },

    async listAllMemory() {
      return memory.map((m) => ({ ...m }));
    },
  };
}

// ---------------------------------------------------------------------------
// Neon implementation
// ---------------------------------------------------------------------------

/** Minimal shape of the neon tagged-template client we rely on. */
type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

function rowToExchange(r: Record<string, unknown>): StoredExchange {
  const timings = (r['timings'] ?? {}) as Partial<TurnAudit['timings']>;
  const models = (r['models'] ?? {}) as Partial<TurnAudit['models']>;
  return {
    id: Number(r['id'] ?? 0),
    sessionId: String(r['session_id'] ?? ''),
    userId: String(r['user_id'] ?? ''),
    createdAt: toDate(r['created_at']),
    utterance: String(r['utterance'] ?? ''),
    spoken: String(r['spoken'] ?? ''),
    cannedId: (r['canned_id'] ?? null) as ExchangeRow['cannedId'],
    audit: normalizeAudit({
      inputVerdict: (r['input_verdict'] ?? undefined) as InputVerdict | undefined,
      inputReason: (r['input_reason'] ?? undefined) as InputReason | undefined,
      inputRaw: (r['input_raw'] ?? null) as string | null,
      generationText: (r['generation_text'] ?? null) as string | null,
      outputVerdict: (r['output_verdict'] ?? null) as OutputVerdict | null,
      outputRaw: (r['output_raw'] ?? null) as string | null,
      flag: asFlag(r['flag']),
      containsPII: r['contains_pii'] === true,
      timings: timings as TurnAudit['timings'],
      models: models as TurnAudit['models'],
      error: (r['error'] ?? null) as string | null,
    }),
  };
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    sessionId: String(r['session_id'] ?? ''),
    userId: String(r['user_id'] ?? ''),
    startedAt: toDate(r['started_at']),
    endedAt: r['ended_at'] == null ? null : toDate(r['ended_at']),
    turnCount: Number(r['turn_count'] ?? 0),
    capHit: r['cap_hit'] === true,
  };
}

/**
 * Build a Neon-backed store. Exported for tests that want to inject a fake
 * `sql` function; production code uses `getStore()`.
 */
export function createNeonStore(sql: Sql): ReviewStore {
  return {
    async loadSession(sessionId, userId) {
      const rows = await sql`
        SELECT * FROM sessions
        WHERE session_id = ${sessionId} AND user_id = ${userId}
        LIMIT 1`;
      const r = rows[0];
      return r ? rowToSession(r) : null;
    },

    async startSession(sessionId, userId) {
      const rows = await sql`
        INSERT INTO sessions (session_id, user_id)
        VALUES (${sessionId}, ${userId})
        ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id
        RETURNING *`;
      const r = rows[0];
      return r
        ? rowToSession(r)
        : {
            sessionId,
            userId,
            startedAt: new Date(),
            endedAt: null,
            turnCount: 0,
            capHit: false,
          };
    },

    async bumpTurn(sessionId) {
      await sql`
        UPDATE sessions SET turn_count = turn_count + 1
        WHERE session_id = ${sessionId}`;
    },

    async endSession(sessionId, capHit) {
      await sql`
        UPDATE sessions
        SET ended_at = now(), cap_hit = cap_hit OR ${capHit}
        WHERE session_id = ${sessionId}`;
    },

    async loadHistory(sessionId, limit) {
      const rows = await sql`
        SELECT utterance, spoken FROM exchanges
        WHERE session_id = ${sessionId} AND flag = 'none'
        ORDER BY id DESC
        LIMIT ${Math.max(0, limit)}`;
      const turns: ConversationTurn[] = [];
      for (const r of rows.slice().reverse()) {
        turns.push({ role: 'user', content: String(r['utterance'] ?? '') });
        turns.push({ role: 'assistant', content: String(r['spoken'] ?? '') });
      }
      return turns;
    },

    async loadMemory(userId) {
      const rows = await sql`
        SELECT line FROM user_memory
        WHERE user_id = ${userId}
        ORDER BY id ASC
        LIMIT ${MEMORY_LINE_CAP}`;
      return rows.map((r) => String(r['line'] ?? '')).filter((l) => l.length > 0);
    },

    async replaceMemory(userId, lines) {
      const capped = lines.slice(Math.max(0, lines.length - MEMORY_LINE_CAP));
      await sql`DELETE FROM user_memory WHERE user_id = ${userId}`;
      for (const line of capped) {
        await sql`
          INSERT INTO user_memory (user_id, line)
          VALUES (${userId}, ${line})`;
      }
    },

    async deleteMemoryLine(userId, id) {
      await sql`
        DELETE FROM user_memory WHERE user_id = ${userId} AND id = ${id}`;
    },

    async logExchange(row) {
      const a = normalizeAudit(row.audit);
      await sql`
        INSERT INTO exchanges (
          session_id, user_id, utterance, spoken, canned_id, flag,
          input_verdict, input_reason, input_raw, generation_text,
          output_verdict, output_raw, contains_pii, timings, models, error
        ) VALUES (
          ${row.sessionId}, ${row.userId}, ${row.utterance}, ${row.spoken},
          ${row.cannedId}, ${a.flag},
          ${a.inputVerdict}, ${a.inputReason}, ${a.inputRaw}, ${a.generationText},
          ${a.outputVerdict}, ${a.outputRaw}, ${a.containsPII},
          ${JSON.stringify(a.timings)}::jsonb, ${JSON.stringify(a.models)}::jsonb,
          ${a.error}
        )`;
    },

    async listFlagged(days, limit = 200) {
      const rows = await sql`
        SELECT * FROM exchanges
        WHERE flag <> 'none'
          AND created_at >= now() - make_interval(days => ${Math.max(0, days)})
        ORDER BY created_at DESC
        LIMIT ${limit}`;
      return rows.map(rowToExchange);
    },

    async listSessions(limit = 50) {
      const rows = await sql`
        SELECT s.*,
          COALESCE(f.none, 0)       AS c_none,
          COALESCE(f.redirected, 0) AS c_redirected,
          COALESCE(f.distress, 0)   AS c_distress,
          COALESCE(f.gate_fail, 0)  AS c_gate_fail,
          COALESCE(f.error, 0)      AS c_error
        FROM sessions s
        LEFT JOIN (
          SELECT session_id,
            count(*) FILTER (WHERE flag = 'none')       AS none,
            count(*) FILTER (WHERE flag = 'redirected') AS redirected,
            count(*) FILTER (WHERE flag = 'distress')   AS distress,
            count(*) FILTER (WHERE flag = 'gate_fail')  AS gate_fail,
            count(*) FILTER (WHERE flag = 'error')      AS error
          FROM exchanges GROUP BY session_id
        ) f ON f.session_id = s.session_id
        ORDER BY s.started_at DESC
        LIMIT ${limit}`;
      return rows.map((r) => ({
        ...rowToSession(r),
        flagCounts: {
          none: Number(r['c_none'] ?? 0),
          redirected: Number(r['c_redirected'] ?? 0),
          distress: Number(r['c_distress'] ?? 0),
          gate_fail: Number(r['c_gate_fail'] ?? 0),
          error: Number(r['c_error'] ?? 0),
        },
      }));
    },

    async loadTranscript(sessionId) {
      const rows = await sql`
        SELECT * FROM exchanges
        WHERE session_id = ${sessionId}
        ORDER BY id ASC`;
      return rows.map(rowToExchange);
    },

    async listAllMemory() {
      const rows = await sql`
        SELECT id, user_id, line, created_at FROM user_memory
        ORDER BY id ASC`;
      return rows.map((r) => ({
        id: Number(r['id'] ?? 0),
        userId: String(r['user_id'] ?? ''),
        line: String(r['line'] ?? ''),
        createdAt: toDate(r['created_at']),
      }));
    },
  };
}

let cached: ReviewStore | null = null;

/**
 * The production store. Requires DATABASE_URL. Cached per process so a warm
 * serverless instance reuses the connection settings.
 *
 * The driver import is dynamic: unit tests import this module for
 * `createInMemoryStore` and must never pull a database driver into the graph.
 * `getStore()` therefore hands back a store whose methods await the driver on
 * first use — no method resolves before DATABASE_URL has been validated here.
 */
export function getStore(): ReviewStore {
  if (cached) return cached;
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Use createInMemoryStore() for tests.',
    );
  }
  let sqlPromise: Promise<Sql> | null = null;
  const lazySql: Sql = async (strings, ...values) => {
    if (!sqlPromise) {
      sqlPromise = import('@neondatabase/serverless').then(
        (m) => m.neon(url) as unknown as Sql,
      );
    }
    const sql = await sqlPromise;
    return sql(strings, ...values);
  };
  cached = createNeonStore(lazySql);
  return cached;
}

/** Test seam: drop the cached production store. */
export function resetStoreCache(): void {
  cached = null;
}
