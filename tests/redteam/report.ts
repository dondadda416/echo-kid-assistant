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
import type { RunReport, CaseResult, TurnResult } from './run.js';

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${Math.round((n / d) * 1000) / 10}%`;
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
  const caseFails = r.cases.filter((c) => !c.pass);
  const gateFails = r.gateCases.filter((g) => !g.pass);
  const allGreen = caseFails.length === 0 && gateFails.length === 0;

  md.push(`# Red-team suite — ${allGreen ? '✅ all green' : '❌ failures'}`);
  md.push('');
  md.push(
    `Mode \`${r.mode}\` · gate model \`${r.models.gate}\` · generation model \`${r.models.generation}\``,
  );
  md.push(`Started ${r.startedAt}, finished ${r.finishedAt}.`);
  if (r.filters.category || r.filters.limit !== null) {
    md.push(
      `Filters: category=\`${String(r.filters.category)}\`, limit=\`${String(r.filters.limit)}\`.`,
    );
  }
  md.push('');

  md.push('## Totals');
  md.push('');
  md.push('| | passed | total | rate |');
  md.push('|---|---:|---:|---:|');
  md.push(
    `| Utterance cases | ${r.totals.casesPassed} | ${r.totals.cases} | ${pct(r.totals.casesPassed, r.totals.cases)} |`,
  );
  md.push(
    `| Output-gate replies | ${r.totals.gateCasesPassed} | ${r.totals.gateCases} | ${pct(r.totals.gateCasesPassed, r.totals.gateCases)} |`,
  );
  md.push('');

  // Per category
  const byCat = new Map<string, { n: number; ok: number }>();
  for (const c of r.cases) {
    const e = byCat.get(c.category) ?? { n: 0, ok: 0 };
    e.n += 1;
    if (c.pass) e.ok += 1;
    byCat.set(c.category, e);
  }
  md.push('## Per category');
  md.push('');
  md.push('| Category | passed | total | rate |');
  md.push('|---|---:|---:|---:|');
  for (const [cat, e] of [...byCat.entries()].sort()) {
    md.push(`| \`${cat}\` | ${e.ok} | ${e.n} | ${pct(e.ok, e.n)} |`);
  }
  md.push('');

  md.push('## Verdict distribution (all turns)');
  md.push('');
  md.push('| Outcome | turns |');
  md.push('|---|---:|');
  for (const [k, v] of Object.entries(r.distribution).sort()) {
    md.push(`| \`${k}\` | ${v} |`);
  }
  md.push('');

  md.push('## Input gate stage split');
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

  md.push('## Model calls');
  md.push('');
  md.push(
    `${r.counters.gateCalls} gate call(s), ${r.counters.genCalls} generation call(s), ${r.counters.retries} retried, ${r.counters.transportErrors} hard transport error(s).`,
  );
  md.push('');

  if (allGreen) {
    md.push('No failures. 🎉');
    return md.join('\n');
  }

  md.push('## Failures');
  md.push('');
  if (caseFails.length > 0) {
    md.push(`### Utterance cases (${caseFails.length})`);
    md.push('');
    md.push('| id | category | turn | expected | actual |');
    md.push('|---|---|---:|---|---|');
    for (const c of caseFails) {
      for (const t of c.turns.filter((x) => !x.pass)) {
        md.push(
          `| \`${c.id}\` | ${c.category} | ${t.index} | \`${[t.expect, ...t.alsoAccept].join(' \\| ')}\` | \`${t.actual}\` |`,
        );
      }
      if (c.turns.every((x) => x.pass)) {
        md.push(`| \`${c.id}\` | ${c.category} | — | — | \`${String(c.error)}\` |`);
      }
    }
    md.push('');
    for (const c of caseFails) {
      md.push(caseDetail(c));
      md.push('');
    }
  }

  if (gateFails.length > 0) {
    md.push(`### Output-gate replies (${gateFails.length})`);
    md.push('');
    for (const g of gateFails) {
      md.push(`#### \`${g.id}\``);
      md.push('');
      md.push(`- expected: \`${g.expect}\``);
      md.push(`- actual: \`${g.actual}\` (raw ${JSON.stringify(g.raw)})`);
      if (g.note) md.push(`- case note: ${g.note}`);
      md.push('');
      md.push('Reply under test:');
      md.push(fence(g.reply));
      md.push('');
    }
  }

  return md.join('\n');
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
