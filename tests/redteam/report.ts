/**
 * Renders a red-team run's JSON (`run.ts --json=<path>`) into markdown.
 *
 * Used by .github/workflows/redteam.yml to write $GITHUB_STEP_SUMMARY, and
 * useful locally:
 *
 *   npm run redteam -- --json=.redteam/run.json
 *   npx tsx tests/redteam/report.ts .redteam/run.json > report.md
 *
 * Reads a path argument, writes markdown to stdout (or to a second path
 * argument, appending, which is what the CI step does).
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type {
  RunReport,
  CaseResult,
  TurnResult,
  UnitAggregate,
  Aggregate,
} from './run.js';

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${Math.round((n / d) * 1000) / 10}%`;
}

function rate(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}

/** `84% (79–88%, n=3)` when n>1, plain `84%` when n=1. */
function range(
  s: { meanRate: number; minRate: number; maxRate: number },
  n: number,
): string {
  if (n <= 1) return rate(s.meanRate);
  return `${rate(s.meanRate)} (${rate(s.minRate)}–${rate(s.maxRate)}, n=${n})`;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * An old JSON (pre-T12) has no `aggregate`. Rather than crash on an artifact
 * from a previous run, synthesise the single-run view it implies.
 */
function aggregateOf(r: RunReport): Aggregate {
  if (r.aggregate) return r.aggregate;
  const units: UnitAggregate[] = [];
  for (const c of r.cases) {
    for (const t of c.turns) {
      units.push({
        key: `turn:${c.id}#${t.index}`,
        kind: 'turn',
        id: c.id,
        category: c.category,
        turn: t.index,
        utterance: t.utterance,
        expected: [t.expect, ...t.alsoAccept].join(' | '),
        note: t.note ?? c.note,
        runs: 1,
        passed: t.pass ? 1 : 0,
        stability: t.pass ? 'consistent_pass' : 'consistent_fail',
        actuals: [t.actual],
        reasons: t.reasons,
        deadlineRuns: 0,
        generationMs: t.audit ? [t.audit.timings.generationMs] : [],
        models: t.audit?.models ?? null,
        redirectKinds: [],
      });
    }
  }
  const n = r.totals.cases;
  const ok = r.totals.casesPassed;
  const gn = r.totals.gateCases;
  const gok = r.totals.gateCasesPassed;
  const one = (v: number): { meanRate: number; minRate: number; maxRate: number } => ({
    meanRate: v,
    minRate: v,
    maxRate: v,
  });
  return {
    repeats: 1,
    units,
    consistentPass: units.filter((u) => u.stability === 'consistent_pass').length,
    flaky: 0,
    consistentFail: units.filter((u) => u.stability === 'consistent_fail').length,
    consistentFailSafety: units.filter((u) => u.stability === 'consistent_fail').length,
    consistentFailDeadline: 0,
    categories: [],
    overall: { perPassRate: [n === 0 ? 0 : ok / n], ...one(n === 0 ? 0 : ok / n) },
    gateOverall: {
      perPassRate: [gn === 0 ? 0 : gok / gn],
      ...one(gn === 0 ? 0 : gok / gn),
    },
    redirectSplit: [],
    deadlines: [],
    transportErrors: r.counters.transportErrors,
  };
}

function fence(text: string, lang = ''): string {
  const safe = text.replace(/```/g, "'''");
  return '```' + lang + '\n' + safe + '\n```';
}

function turnDetail(t: TurnResult): string {
  const out: string[] = [];
  out.push(`**Turn ${t.index}** — ${t.pass ? 'pass' : '**FAIL**'}`);
  out.push('');
  out.push(`- utterance: \`${t.utterance.replace(/`/g, "'")}\``);
  out.push(`- expected: \`${[t.expect, ...t.alsoAccept].join(' | ')}\``);
  out.push(`- actual: \`${t.actual}\` (cannedId \`${String(t.cannedId)}\`)`);
  out.push(`- stage A: \`${t.stageA}\``);
  out.push(`- generation calls: ${t.genCalls}`);
  if (t.note) out.push(`- case note: ${t.note}`);
  for (const r of t.reasons) out.push(`- why it failed: ${r}`);
  for (const h of t.forbidden) {
    out.push(
      `- forbidden phrase \`${h.needle}\`${h.suppressed ? ' _(suppressed by a negator — not counted)_' : ''}: …${h.context}…`,
    );
  }
  out.push('');
  out.push('Spoken text:');
  out.push(fence(t.spoken));

  const a = t.audit;
  if (a) {
    out.push('');
    out.push('<details><summary>TurnAudit</summary>');
    out.push('');
    out.push(
      fence(
        [
          `inputVerdict  : ${a.inputVerdict}`,
          `inputReason   : ${a.inputReason}`,
          `inputRaw      : ${JSON.stringify(a.inputRaw)}`,
          `outputVerdict : ${String(a.outputVerdict)}`,
          `outputRaw     : ${JSON.stringify(a.outputRaw)}`,
          `flag          : ${a.flag}`,
          `containsPII   : ${String(a.containsPII)}`,
          `error         : ${String(a.error)}`,
          `timings       : input ${a.timings.inputGateMs}ms, gen ${a.timings.generationMs}ms, output ${a.timings.outputGateMs}ms, total ${a.timings.totalMs}ms`,
          `models        : gate=${a.models.gate} gen=${a.models.generation}`,
        ].join('\n'),
      ),
    );
    out.push('');
    out.push('Raw generation draft (what the model actually produced):');
    out.push(fence(a.generationText ?? '(generation never ran)'));
    out.push('');
    out.push('</details>');
  }
  return out.join('\n');
}

function caseDetail(c: CaseResult): string {
  const out: string[] = [];
  out.push(`### \`${c.id}\` — ${c.category}`);
  out.push('');
  if (c.note) out.push(`> ${c.note}`, '');
  if (c.error) out.push(`**The pipeline threw:** \`${c.error}\``, '');
  // Multi-turn cases print every turn: the passing turns are the context that
  // explains the failing one.
  for (const t of c.turns) {
    out.push(turnDetail(t));
    out.push('');
  }
  return out.join('\n');
}

export function renderReport(r: RunReport): string {
  const md: string[] = [];
  const a = aggregateOf(r);
  const n = r.repeats ?? 1;

  const consistent = a.units.filter((u) => u.stability === 'consistent_fail');
  const safetyFails = consistent.filter((u) => u.deadlineRuns !== u.runs);
  const deadlineFails = consistent.filter((u) => u.deadlineRuns === u.runs);
  const flaky = a.units.filter((u) => u.stability === 'flaky');
  const allGreen = consistent.length === 0;

  md.push(`# Red-team suite — ${allGreen ? '✅ no consistent failures' : '❌ consistent failures'}`);
  md.push('');

  if (n <= 1) {
    md.push(
      '> ⚠️ **SINGLE RUN — treat every number here as ±5 points.** Run-to-run',
      '> noise on identical code is 3–5 points overall and 10+ points in a single',
      '> category. **See the nightly `--repeat=3` run for the real number.**',
      '> Do not tune a prompt against this page.',
    );
    md.push('');
  } else {
    md.push(
      `> Aggregated over **${n} repeats** of the whole corpus. A case is judged by`,
      '> exactly the same rules as a single run; the repeats only say how *often*',
      '> that judgement comes out the same way.',
    );
    md.push('');
  }

  md.push(
    `Mode \`${r.mode}\` · repeats **${n}** · gate model \`${r.models.gate}\` · generation model \`${r.models.generation}\``,
  );
  md.push(`Started ${r.startedAt}, finished ${r.finishedAt}.`);
  if (r.filters.category || r.filters.limit !== null) {
    md.push(
      `Filters: category=\`${String(r.filters.category)}\`, limit=\`${String(r.filters.limit)}\`.`,
    );
  }
  md.push('');

  // --- The three headline numbers, in plain words ---------------------------
  md.push('## What this run says');
  md.push('');
  md.push('| | count | what it means |');
  md.push('|---|---:|---|');
  md.push(
    `| **Consistent failures** | ${safetyFails.length} | Failed in ${n === 1 ? 'the run' : `all ${n} repeats`}. These are bugs. They fail the build. |`,
  );
  md.push(
    `| **Flaky** | ${flaky.length} | Passed sometimes and failed sometimes. A human has to decide. **These do not fail the build** — a build that goes red at random is a build people learn to ignore. |`,
  );
  md.push(
    `| **Deadline turns** | ${a.deadlines.length} | The turn ran out of time. That is latency, not safety — it is counted separately below. ${deadlineFails.length > 0 ? `${deadlineFails.length} timed out in every repeat and ${deadlineFails.length === 1 ? 'still fails' : 'still fail'} the build.` : ''} |`,
  );
  md.push(
    `| Consistent passes | ${a.consistentPass} | Passed every repeat. |`,
  );
  md.push('');

  // --- Totals ---------------------------------------------------------------
  md.push('## Totals');
  md.push('');
  md.push(`| | rate | per repeat |`);
  md.push('|---|---|---|');
  md.push(
    `| Utterance cases | ${range(a.overall, n)} | ${a.overall.perPassRate.map(rate).join(', ')} |`,
  );
  md.push(
    `| Output-gate replies | ${range(a.gateOverall, n)} | ${a.gateOverall.perPassRate.map(rate).join(', ')} |`,
  );
  md.push('');
  if (r.passes && r.passes.length > 0) {
    md.push('| Repeat | cases | output-gate | wall clock | est. cost |');
    md.push('|---:|---|---|---:|---:|');
    for (const p of r.passes) {
      md.push(
        `| ${p.index} | ${p.totals.casesPassed}/${p.totals.cases} (${pct(p.totals.casesPassed, p.totals.cases)}) | ${p.totals.gateCasesPassed}/${p.totals.gateCases} | ${Math.round(p.durationMs / 1000)}s | $${p.estimatedCostUsd.toFixed(2)} |`,
      );
    }
    md.push('');
  }

  // --- Per category ---------------------------------------------------------
  md.push('## Per category');
  md.push('');
  if (a.categories.length > 0) {
    md.push('| Category | cases | rate | per repeat |');
    md.push('|---|---:|---|---|');
    for (const c of a.categories) {
      md.push(
        `| \`${c.category}\` | ${c.cases} | ${range(c, n)} | ${c.perPassPassed.join(' / ')} |`,
      );
    }
  } else {
    const byCat = new Map<string, { n: number; ok: number }>();
    for (const c of r.cases) {
      const e = byCat.get(c.category) ?? { n: 0, ok: 0 };
      e.n += 1;
      if (c.pass) e.ok += 1;
      byCat.set(c.category, e);
    }
    md.push('| Category | passed | total | rate |');
    md.push('|---|---:|---:|---:|');
    for (const [cat, e] of [...byCat.entries()].sort()) {
      md.push(`| \`${cat}\` | ${e.ok} | ${e.n} | ${pct(e.ok, e.n)} |`);
    }
  }
  md.push('');

  // --- Redirect provenance --------------------------------------------------
  if (a.redirectSplit.length > 0) {
    const canned = a.redirectSplit.map((s) => s.canned);
    const self = a.redirectSplit.map((s) => s.self);
    md.push('## How the redirects happened');
    md.push('');
    md.push(
      'Both of these are correct outcomes. The split is here because a drift',
      'from the approved canned line toward the model refusing in its own words',
      'is worth noticing even though both pass.',
    );
    md.push('');
    md.push('| | mean per repeat | per repeat |');
    md.push('|---|---:|---|');
    md.push(
      `| REDIRECT by canned line | ${Math.round(mean(canned) * 10) / 10} | ${canned.join(', ')} |`,
    );
    md.push(
      `| REDIRECT by self-refusal (judged) | ${Math.round(mean(self) * 10) / 10} | ${self.join(', ')} |`,
    );
    md.push('');
  }

  md.push('## Verdict distribution (repeat 1, all turns)');
  md.push('');
  md.push('| Outcome | turns |');
  md.push('|---|---:|');
  for (const [k, v] of Object.entries(r.distribution).sort()) {
    md.push(`| \`${k}\` | ${v} |`);
  }
  md.push('');

  // --- Section 1: consistent failures ---------------------------------------
  md.push(`## 1. Consistent failures — these are bugs (${safetyFails.length})`);
  md.push('');
  if (safetyFails.length === 0) {
    md.push('None. Nothing failed in every repeat.');
  } else {
    md.push('| unit | category | passed | expected | seen | why |');
    md.push('|---|---|---:|---|---|---|');
    for (const u of safetyFails) {
      md.push(
        `| \`${u.key}\` | ${u.category} | ${u.passed}/${u.runs} | \`${u.expected.replace(/\|/g, '\\|')}\` | \`${u.actuals.join(', ')}\` | ${u.reasons.join('; ').replace(/\|/g, '\\|') || '—'} |`,
      );
    }
  }
  md.push('');

  // --- Section 2: flaky -----------------------------------------------------
  md.push(`## 2. Flaky — these need a human decision (${flaky.length})`);
  md.push('');
  if (n <= 1) {
    md.push(
      '_A single run cannot see flakiness: every unit is 1/1 or 0/1. Run',
      '`--repeat=3` to populate this section._',
    );
  } else if (flaky.length === 0) {
    md.push('None. Every unit came out the same way in all repeats.');
  } else {
    md.push(
      'These passed in some repeats and failed in others. **The build is green',
      'anyway, on purpose.** A flaky safety case is a real signal that deserves a',
      'person reading it, not a pipeline that goes red at random. Do not tune a',
      'prompt against one of these without more repeats.',
    );
    md.push('');
    md.push('| unit | category | passed | expected | seen per repeat | why (any repeat) |');
    md.push('|---|---|---:|---|---|---|');
    for (const u of flaky) {
      md.push(
        `| \`${u.key}\` | ${u.category} | ${u.passed}/${u.runs} | \`${u.expected.replace(/\|/g, '\\|')}\` | \`${u.actuals.join(', ')}\` | ${u.reasons.join('; ').replace(/\|/g, '\\|') || '—'} |`,
      );
    }
    md.push('');
    for (const u of flaky) {
      if (u.utterance && u.kind === 'turn') {
        md.push(`- \`${u.key}\`: \`${u.utterance.replace(/`/g, "'")}\`${u.note ? ` — ${u.note}` : ''}`);
      }
    }
  }
  md.push('');

  // --- Section 3: deadline / transport --------------------------------------
  md.push(
    `## 3. Deadline / transport — latency, not safety (${a.deadlines.length} turn observation(s))`,
  );
  md.push('');
  md.push(
    'These turns ran out of the pipeline deadline. A story that timed out is a',
    'latency problem; it tells you nothing about whether the assistant is safe,',
    'and it is deliberately kept out of the failure counts above so it cannot be',
    'mistaken for leaked content.',
  );
  md.push('');
  if (a.deadlines.length === 0) {
    md.push(`No deadline turns. ${a.transportErrors} hard transport error(s).`);
  } else {
    md.push('| unit | repeat | category | generationMs | totalMs | generation model |');
    md.push('|---|---:|---|---:|---:|---|');
    for (const d of a.deadlines) {
      md.push(
        `| \`${d.id}#${d.turn}\` | ${d.repeat} | ${d.category} | ${d.generationMs} | ${d.totalMs} | \`${d.models?.generation ?? '?'}\` |`,
      );
    }
    md.push('');
    md.push(
      `Hard transport errors across all repeats: ${a.transportErrors}.`,
    );
    if (deadlineFails.length > 0) {
      md.push('');
      md.push(
        `**${deadlineFails.length} of these timed out in every repeat**, so they are consistent failures and do fail the build: ` +
          deadlineFails.map((u) => `\`${u.key}\``).join(', ') + '.',
      );
    }
  }
  md.push('');

  // --- Stage A, calls, cost -------------------------------------------------
  md.push('## Input gate stage split (repeat 1)');
  md.push('');
  md.push(
    `${r.stageA.decided} turn(s) decided deterministically by stage A (the generation model never saw them); ${r.stageA.deferred} deferred to the classifier.`,
  );
  if (r.stageA.mismatches.length > 0) {
    md.push('');
    md.push('Stage-A mismatches:');
    md.push('');
    for (const m of r.stageA.mismatches) {
      md.push(
        `- \`${m.id}\` turn ${m.turn}: stage A said \`${m.stageA}\`, corpus expects \`${m.expected}\` — \`${m.utterance}\``,
      );
    }
  }
  md.push('');

  md.push('## Model calls and estimated cost');
  md.push('');
  md.push(
    `${r.counters.gateCalls} gate call(s), ${r.counters.genCalls} generation call(s), ${r.counters.retries} retried, ${r.counters.transportErrors} hard transport error(s) — totals across all ${n} repeat(s).`,
  );
  md.push('');
  if (r.prices) {
    md.push(
      `**Estimated cost: $${(r.estimatedCostUsd ?? 0).toFixed(2)}** for this run.`,
    );
    md.push('');
    md.push('| | input tok (~) | output tok (~) | $/MTok in | $/MTok out |');
    md.push('|---|---:|---:|---:|---:|');
    md.push(
      `| gate model | ${r.counters.gateInputTokensApprox} | ${r.counters.gateOutputTokensApprox} | $${r.prices.gateIn} | $${r.prices.gateOut} |`,
    );
    md.push(
      `| generation model | ${r.counters.genInputTokensApprox} | ${r.counters.genOutputTokensApprox} | $${r.prices.genIn} | $${r.prices.genOut} |`,
    );
    md.push('');
    md.push(
      '_Token counts are approximated as characters/4 on the exact strings sent and',
      'received; prices are **assumptions** (Haiku-class gate, Sonnet-class',
      'generation) set in `prices()` and overridable with `PRICE_GATE_IN`,',
      '`PRICE_GATE_OUT`, `PRICE_GEN_IN`, `PRICE_GEN_OUT`. To correct the number',
      'later, multiply the token counts above by the real published price._',
    );
  }
  md.push('');

  // --- Detail for consistent failures only ----------------------------------
  if (consistent.length === 0) {
    md.push('No consistent failures. 🎉');
    return md.join('\n');
  }

  md.push('## Consistent failure detail');
  md.push('');
  md.push(
    '_Flaky units are deliberately not dumped in full here: the interesting thing',
    'about a flaky unit is the variation, which the table above shows._',
  );
  md.push('');

  const seen = new Set<string>();
  for (const u of consistent) {
    if (u.kind !== 'turn') continue;
    const hit = lastFailingObservation(r, u);
    if (!hit) continue;
    const key = `${u.id}#${u.turn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    md.push(
      caseDetail({
        id: u.id,
        category: u.category,
        pass: false,
        turns: [hit.turn],
        error: hit.caseError,
        note: u.note,
      }),
    );
    md.push(`_(observation from repeat ${hit.pass} of ${n}; ${u.passed}/${u.runs} repeats passed)_`);
    md.push('');
  }

  const gateUnits = consistent.filter((u) => u.kind === 'gate');
  if (gateUnits.length > 0) {
    md.push(`### Output-gate replies (${gateUnits.length})`);
    md.push('');
    for (const u of gateUnits) {
      const g = lastFailingGate(r, u.id);
      md.push(`#### \`${u.id}\``);
      md.push('');
      md.push(`- expected: \`${u.expected}\``);
      md.push(`- actual per repeat: \`${u.actuals.join(', ')}\``);
      if (g) md.push(`- raw: ${JSON.stringify(g.raw)}`);
      if (u.note) md.push(`- case note: ${u.note}`);
      md.push('');
      md.push('Reply under test:');
      md.push(fence(g?.reply ?? u.utterance ?? ''));
      md.push('');
    }
  }

  return md.join('\n');
}

/** The most recent repeat in which this unit was observed failing. */
function lastFailingObservation(
  r: RunReport,
  u: UnitAggregate,
): { pass: number; turn: TurnResult; caseError: string | null } | null {
  const passes =
    r.passes && r.passes.length > 0
      ? r.passes
      : [{ index: 1, cases: r.cases } as unknown as RunReport['passes'][number]];
  for (let p = passes.length - 1; p >= 0; p -= 1) {
    const cr = passes[p]!.cases.find((c) => c.id === u.id);
    const tr = cr?.turns[(u.turn ?? 1) - 1];
    if (tr && !tr.pass) {
      return { pass: p + 1, turn: tr, caseError: cr?.error ?? null };
    }
  }
  return null;
}

function lastFailingGate(
  r: RunReport,
  id: string,
): { raw: string | null; reply: string } | null {
  const passes =
    r.passes && r.passes.length > 0
      ? r.passes
      : [{ index: 1, gateCases: r.gateCases } as unknown as RunReport['passes'][number]];
  for (let p = passes.length - 1; p >= 0; p -= 1) {
    const g = passes[p]!.gateCases.find((x) => x.id === id);
    if (g && !g.pass) return { raw: g.raw, reply: g.reply };
  }
  return null;
}

function main(): void {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath) {
    console.error('usage: tsx tests/redteam/report.ts <run.json> [out.md]');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(inPath, 'utf8')) as RunReport;
  const md = renderReport(report);
  if (outPath) appendFileSync(outPath, md + '\n', 'utf8');
  else process.stdout.write(md + '\n');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
