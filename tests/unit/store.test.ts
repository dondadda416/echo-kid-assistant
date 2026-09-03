import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryStore, MEMORY_LINE_CAP, type ReviewStore } from '../../src/memory/db.ts';
import { deriveFlag, logExchange } from '../../src/log/exchange.ts';
import {
  capState,
  ensureSession,
  loadRecentTurns,
  sanitizeHistory,
  sessionDurationMinutes,
} from '../../src/memory/session.ts';
import {
  extractMemory,
  mergeMemory,
  parseModelLines,
  shouldSkipExtraction,
  updateMemoryAfterResponse,
} from '../../src/memory/longTerm.ts';
import { describe as describeStmt, splitStatements } from '../../src/memory/migrate.ts';
import type { ExchangeRow, TurnAudit } from '../../src/types.ts';

function audit(over: Partial<TurnAudit> = {}): TurnAudit {
  return {
    inputVerdict: 'OK',
    inputReason: 'clean',
    inputRaw: 'OK',
    generationText: 'Horses sleep standing up.',
    outputVerdict: 'PASS',
    outputRaw: 'PASS',
    flag: 'none',
    containsPII: false,
    timings: { inputGateMs: 10, generationMs: 20, outputGateMs: 5, totalMs: 40 },
    models: { gate: 'gate-model', generation: 'gen-model' },
    error: null,
    ...over,
  };
}

function row(over: Partial<ExchangeRow> = {}): ExchangeRow {
  return {
    sessionId: 's1',
    userId: 'u1',
    utterance: 'why do horses sleep standing up',
    spoken: 'Horses sleep standing up.',
    cannedId: null,
    audit: audit(),
    ...over,
  };
}

let store: ReviewStore;
beforeEach(() => {
  store = createInMemoryStore();
});

describe('sessions', () => {
  it('startSession creates a row and loadSession reads it back', async () => {
    const created = await store.startSession('s1', 'u1');
    expect(created.sessionId).toBe('s1');
    expect(created.turnCount).toBe(0);
    expect(created.capHit).toBe(false);
    expect(created.endedAt).toBeNull();

    const loaded = await store.loadSession('s1', 'u1');
    expect(loaded?.userId).toBe('u1');
  });

  it('loadSession returns null for an unknown session', async () => {
    expect(await store.loadSession('nope', 'u1')).toBeNull();
  });

  it('startSession is idempotent', async () => {
    const a = await store.startSession('s1', 'u1');
    const b = await store.startSession('s1', 'u1');
    expect(b.startedAt.getTime()).toBe(a.startedAt.getTime());
  });

  it('bumpTurn increments and endSession closes', async () => {
    await store.startSession('s1', 'u1');
    await store.bumpTurn('s1');
    await store.bumpTurn('s1');
    expect((await store.loadSession('s1', 'u1'))?.turnCount).toBe(2);

    await store.endSession('s1', true);
    const closed = await store.loadSession('s1', 'u1');
    expect(closed?.endedAt).toBeInstanceOf(Date);
    expect(closed?.capHit).toBe(true);
  });

  it('bumpTurn and endSession on an unknown session are no-ops', async () => {
    await expect(store.bumpTurn('ghost')).resolves.toBeUndefined();
    await expect(store.endSession('ghost', false)).resolves.toBeUndefined();
  });
});

describe('history', () => {
  it('returns approved turns oldest first', async () => {
    await store.startSession('s1', 'u1');
    await store.logExchange(row({ utterance: 'q1', spoken: 'a1' }));
    await store.logExchange(row({ utterance: 'q2', spoken: 'a2' }));

    const turns = await store.loadHistory('s1', 12);
    expect(turns).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('never returns rejected or redirected turns', async () => {
    await store.logExchange(
      row({ utterance: 'bad question', spoken: 'Ask Mom or Dad.', audit: audit({ flag: 'redirected', inputVerdict: 'SENSITIVE' }) }),
    );
    await store.logExchange(
      row({ utterance: 'blocked', spoken: 'Ask Mom or Dad.', audit: audit({ flag: 'gate_fail', outputVerdict: 'FAIL' }) }),
    );
    await store.logExchange(row({ utterance: 'ok one', spoken: 'sure' }));

    const turns = await store.loadHistory('s1', 12);
    expect(turns.map((t) => t.content)).toEqual(['ok one', 'sure']);
  });

  it('trims to the requested number of exchanges', async () => {
    for (let i = 0; i < 10; i++) {
      await store.logExchange(row({ utterance: `q${i}`, spoken: `a${i}` }));
    }
    const turns = await store.loadHistory('s1', 2);
    expect(turns).toHaveLength(4);
    expect(turns[0]).toEqual({ role: 'user', content: 'q8' });
  });

  it('is scoped to one session', async () => {
    await store.logExchange(row({ sessionId: 'sA', utterance: 'a' }));
    await store.logExchange(row({ sessionId: 'sB', utterance: 'b' }));
    const turns = await store.loadHistory('sA', 12);
    expect(turns.map((t) => t.content)).toContain('a');
    expect(turns.map((t) => t.content)).not.toContain('b');
  });

  it('sanitizeHistory drops empties and never starts on an assistant turn', () => {
    const out = sanitizeHistory(
      [
        { role: 'assistant', content: 'orphan' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '   ' },
        { role: 'assistant', content: 'hello' },
      ],
      12,
    );
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('loadRecentTurns survives a storage failure', async () => {
    const broken = {
      ...store,
      loadHistory: async () => {
        throw new Error('db down');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadRecentTurns(broken, 's1', 12)).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe('memory', () => {
  it('replaceMemory / loadMemory round-trip', async () => {
    await store.replaceMemory('u1', ['likes horses', 'enjoys riddles']);
    expect(await store.loadMemory('u1')).toEqual(['likes horses', 'enjoys riddles']);
  });

  it('memory is scoped per user', async () => {
    await store.replaceMemory('u1', ['likes horses']);
    await store.replaceMemory('u2', ['likes trains']);
    expect(await store.loadMemory('u1')).toEqual(['likes horses']);
    expect(await store.loadMemory('u2')).toEqual(['likes trains']);
  });

  it('caps at 20 lines, dropping the oldest first', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
    await store.replaceMemory('u1', lines);
    const stored = await store.loadMemory('u1');
    expect(stored).toHaveLength(MEMORY_LINE_CAP);
    expect(stored[0]).toBe('line 5');
    expect(stored[stored.length - 1]).toBe('line 24');
  });

  it('deleteMemoryLine removes one line by id', async () => {
    await store.replaceMemory('u1', ['likes horses', 'enjoys riddles']);
    const all = await store.listAllMemory();
    const target = all.find((m) => m.line === 'likes horses');
    expect(target).toBeDefined();
    await store.deleteMemoryLine('u1', target!.id);
    expect(await store.loadMemory('u1')).toEqual(['enjoys riddles']);
  });

  it('deleteMemoryLine will not delete another user’s line', async () => {
    await store.replaceMemory('u1', ['likes horses']);
    const [line] = await store.listAllMemory();
    await store.deleteMemoryLine('someone-else', line!.id);
    expect(await store.loadMemory('u1')).toEqual(['likes horses']);
  });
});

describe('logExchange', () => {
  it('writes a row for a normal turn', async () => {
    const ok = await logExchange(store, row());
    expect(ok).toBe(true);
    const rows = await store.loadTranscript('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.utterance).toBe('why do horses sleep standing up');
    expect(rows[0]!.audit.flag).toBe('none');
  });

  it('writes a row for an ERROR turn', async () => {
    await logExchange(
      store,
      row({
        spoken: 'My thinking got a little tangled.',
        cannedId: 'TIMEOUT',
        audit: audit({
          generationText: null,
          outputVerdict: null,
          outputRaw: null,
          error: 'deadline exceeded',
          flag: 'none',
        }),
      }),
    );
    const rows = await store.loadTranscript('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.audit.error).toBe('deadline exceeded');
    expect(rows[0]!.audit.flag).toBe('error');
    expect(rows[0]!.cannedId).toBe('TIMEOUT');
  });

  it('never throws when the store fails', async () => {
    const broken = {
      ...store,
      logExchange: async () => {
        throw new Error('insert failed');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(logExchange(broken, row())).resolves.toBe(false);
    spy.mockRestore();
  });

  it('derives the flag from the audit per §7.5', () => {
    expect(deriveFlag({ inputVerdict: 'DISTRESS', outputVerdict: null, error: null })).toBe('distress');
    expect(deriveFlag({ inputVerdict: 'SENSITIVE', outputVerdict: null, error: null })).toBe('redirected');
    expect(deriveFlag({ inputVerdict: 'NOISE', outputVerdict: null, error: null })).toBe('none');
    expect(deriveFlag({ inputVerdict: 'OK', outputVerdict: 'PASS', error: null })).toBe('none');
    expect(deriveFlag({ inputVerdict: 'OK', outputVerdict: 'FAIL', error: null })).toBe('gate_fail');
    expect(deriveFlag({ inputVerdict: 'OK', outputVerdict: null, error: 'boom' })).toBe('error');
    // distress outranks an error on the same turn
    expect(deriveFlag({ inputVerdict: 'DISTRESS', outputVerdict: null, error: 'boom' })).toBe('distress');
  });

  it('fills in an unset flag rather than under-reporting', async () => {
    await logExchange(
      store,
      row({ audit: audit({ inputVerdict: 'DISTRESS', flag: 'none', outputVerdict: null }) }),
    );
    const rows = await store.loadTranscript('s1');
    expect(rows[0]!.audit.flag).toBe('distress');
  });

  it('keeps a flag the pipeline already set', async () => {
    await logExchange(store, row({ audit: audit({ flag: 'gate_fail', outputVerdict: 'FAIL' }) }));
    const rows = await store.loadTranscript('s1');
    expect(rows[0]!.audit.flag).toBe('gate_fail');
  });

  it('stored rows are snapshots — later mutation of the audit does not change them', async () => {
    const r = row();
    await store.logExchange(r);
    r.audit.generationText = 'mutated';
    const rows = await store.loadTranscript('s1');
    expect(rows[0]!.audit.generationText).toBe('Horses sleep standing up.');
  });
});

describe('review queries', () => {
  it('listFlagged returns only flagged rows from the window', async () => {
    await logExchange(store, row());
    await logExchange(store, row({ audit: audit({ inputVerdict: 'DISTRESS', outputVerdict: null }) }));
    await logExchange(store, row({ audit: audit({ inputVerdict: 'SENSITIVE', outputVerdict: null }) }));

    const flagged = await store.listFlagged(7);
    expect(flagged).toHaveLength(2);
    expect(flagged.every((f) => f.audit.flag !== 'none')).toBe(true);
  });

  it('listSessions tallies flags per session', async () => {
    await store.startSession('s1', 'u1');
    await store.bumpTurn('s1');
    await logExchange(store, row());
    await logExchange(store, row({ audit: audit({ inputVerdict: 'DISTRESS', outputVerdict: null }) }));

    const [summary] = await store.listSessions();
    expect(summary!.sessionId).toBe('s1');
    expect(summary!.turnCount).toBe(1);
    expect(summary!.flagCounts.distress).toBe(1);
    expect(summary!.flagCounts.none).toBe(1);
  });

  it('loadTranscript returns every turn in order, flagged ones included', async () => {
    await logExchange(store, row({ utterance: 'one' }));
    await logExchange(store, row({ utterance: 'two', audit: audit({ inputVerdict: 'SENSITIVE', outputVerdict: null }) }));
    const rows = await store.loadTranscript('s1');
    expect(rows.map((r) => r.utterance)).toEqual(['one', 'two']);
  });
});

describe('session cap helpers', () => {
  const policy = { sessionCapMinutes: 10, turnCap: 40 };

  it('is not hit at the start', async () => {
    const s = await store.startSession('s1', 'u1');
    expect(capState(s, policy).capHit).toBe(false);
  });

  it('trips on elapsed minutes', async () => {
    const s = await store.startSession('s1', 'u1');
    const later = new Date(s.startedAt.getTime() + 11 * 60_000);
    const state = capState(s, policy, later);
    expect(state.capHit).toBe(true);
    expect(state.reason).toBe('minutes');
  });

  it('trips on the turn cap', async () => {
    const s = await store.startSession('s1', 'u1');
    const state = capState({ ...s, turnCount: 40 }, policy);
    expect(state.capHit).toBe(true);
    expect(state.reason).toBe('turns');
  });

  it('sessionDurationMinutes uses endedAt when present', async () => {
    const s = await store.startSession('s1', 'u1');
    const ended = { ...s, endedAt: new Date(s.startedAt.getTime() + 7 * 60_000) };
    expect(sessionDurationMinutes(ended)).toBe(7);
  });

  it('ensureSession falls back to an ephemeral row when storage fails', async () => {
    const broken = {
      ...store,
      loadSession: async () => {
        throw new Error('db down');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await ensureSession(broken, 's9', 'u9');
    expect(s.sessionId).toBe('s9');
    expect(s.turnCount).toBe(0);
    spy.mockRestore();
  });
});

describe('memory extraction', () => {
  const model = (out: string) => vi.fn(async () => out);

  it('extracts at most two scrubbed lines', async () => {
    const call = model('likes stories about horses\npracticing subtraction with borrowing\ncurious about volcanoes');
    const lines = await extractMemory(row(), [], call);
    expect(lines).toEqual([
      'likes stories about horses',
      'practicing subtraction with borrowing',
    ]);
  });

  it('drops model output that would leak identifying detail', async () => {
    const call = model('her name is Emma\nlikes horses');
    expect(await extractMemory(row(), [], call)).toEqual(['likes horses']);
  });

  it('drops everything when the model ignores its instructions', async () => {
    const call = model('goes to Lincoln Elementary\nlives at 42 Maple Street\nher teacher is Mrs Parker');
    expect(await extractMemory(row(), [], call)).toEqual([]);
  });

  it('does not repeat a line already stored', async () => {
    const call = model('likes horses');
    expect(await extractMemory(row(), ['likes horses'], call)).toEqual([]);
  });

  it('handles NONE', async () => {
    expect(await extractMemory(row(), [], model('NONE'))).toEqual([]);
    expect(parseModelLines('NONE')).toEqual([]);
  });

  it('is skipped when the deterministic PII scan fired', async () => {
    const call = model('likes horses');
    const r = row({ audit: audit({ containsPII: true }) });
    expect(shouldSkipExtraction(r)).toBe(true);
    expect(await extractMemory(r, [], call)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['redirected', 'distress', 'gate_fail', 'error'] as const)(
    'is skipped for a %s turn',
    async (flag) => {
      const call = model('likes horses');
      const r = row({ audit: audit({ flag }) });
      expect(await extractMemory(r, [], call)).toEqual([]);
      expect(call).not.toHaveBeenCalled();
    },
  );

  it('never throws when the model call rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = vi.fn(async () => {
      throw new Error('model exploded');
    });
    await expect(extractMemory(row(), [], call)).resolves.toEqual([]);
    spy.mockRestore();
  });

  it('mergeMemory keeps the newest 20 lines', () => {
    const existing = Array.from({ length: 20 }, (_, i) => `old ${i}`);
    const merged = mergeMemory(existing, ['new a', 'new b']);
    expect(merged).toHaveLength(20);
    expect(merged[0]).toBe('old 2');
    expect(merged.slice(-2)).toEqual(['new a', 'new b']);
  });

  it('updateMemoryAfterResponse persists the merged, capped list', async () => {
    await store.replaceMemory('u1', Array.from({ length: 20 }, (_, i) => `old ${i}`));
    const merged = await updateMemoryAfterResponse(store, row(), model('likes horses'));
    expect(merged).toHaveLength(20);
    const stored = await store.loadMemory('u1');
    expect(stored).toHaveLength(20);
    expect(stored[0]).toBe('old 1');
    expect(stored[19]).toBe('likes horses');
  });

  it('updateMemoryAfterResponse never rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      ...store,
      loadMemory: async () => {
        throw new Error('db down');
      },
    };
    await expect(
      updateMemoryAfterResponse(broken, row(), model('likes horses')),
    ).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe('migration file', () => {
  it('splits into statements and names them', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(
      new URL('../../src/memory/schema.sql', import.meta.url),
      'utf8',
    );
    const stmts = splitStatements(sql);
    expect(stmts.length).toBeGreaterThanOrEqual(8);
    expect(stmts.every((s) => /if not exists/i.test(s))).toBe(true);
    expect(describeStmt(stmts[0]!)).toBe('table sessions');
  });
});
