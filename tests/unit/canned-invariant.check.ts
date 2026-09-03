/**
 * Safety lint — run with `npm run lint:canned`.
 *
 * Enforces spec §2.1 / §12 T3(c): the only unchecked strings that can reach
 * the child are the canned lines in src/pipeline/canned.ts.
 *
 * Two checks:
 *   1. In src/pipeline/index.ts, every `speech:` value must be either a
 *      `canned(...)` call or the single approved variable `approvedSpeech`
 *      (which is only produced after an exact PASS from the output gate).
 *   2. No string literal longer than MAX_LITERAL characters may appear
 *      anywhere in src/pipeline/ except canned.ts. Long literals are how
 *      speakable text sneaks into the response path. A literal that is
 *      genuinely not speech (a long prompt path, say) can be exempted with a
 *      trailing `/* not-speech *\/` marker on the same line, which is visible
 *      in review.
 *
 * Exits non-zero with a specific message on any violation.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PIPELINE_DIR = fileURLToPath(
  new URL('../../src/pipeline/', import.meta.url),
);

const MAX_LITERAL = 25;
const CANNED_FILE = 'canned.ts';
const ALLOWED_SPEECH = /^(canned\s*\(|approvedSpeech\b)/;
const EXEMPT_MARKER = 'not-speech';

interface Literal {
  value: string;
  line: number;
}

interface Scan {
  /** Source with comments blanked out (strings preserved). */
  code: string;
  literals: Literal[];
}

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%~^<>'.split(''));

/** Single-pass scanner: blanks comments, collects string literals. */
function scan(src: string): Scan {
  const out: string[] = [];
  const literals: Literal[] = [];
  let line = 1;
  let i = 0;
  let lastSignificant = '';

  const push = (ch: string): void => {
    out.push(ch);
    if (ch === '\n') line++;
  };

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      out.push(' ', ' ');
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          out.push('\n');
          line++;
        } else {
          out.push(' ');
        }
        i++;
      }
      i += 2;
      out.push(' ', ' ');
      continue;
    }
    // Regex literal (only where a regex can legally start)
    if (ch === '/' && REGEX_PRECEDERS.has(lastSignificant)) {
      push(ch);
      i++;
      let inClass = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === '\\') {
          push(c);
          const d = src[i + 1];
          if (d !== undefined) push(d);
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          push(c);
          i++;
          break;
        } else if (c === '\n') break;
        push(c);
        i++;
      }
      lastSignificant = '/';
      continue;
    }
    // String literal
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const startLine = line;
      let value = '';
      push(ch);
      i++;
      while (i < src.length) {
        const c = src[i]!;
        if (c === '\\') {
          push(c);
          const d = src[i + 1];
          if (d !== undefined) push(d);
          value += d ?? '';
          i += 2;
          continue;
        }
        if (c === quote) {
          push(c);
          i++;
          break;
        }
        push(c);
        value += c;
        i++;
      }
      // For template literals, only the STATIC text can be speech; the
      // `${...}` holes are code. Measure the static parts.
      const measured =
        quote === '`' ? value.replace(/\$\{[^}]*\}/g, '') : value;
      literals.push({ value: measured, line: startLine });
      lastSignificant = quote;
      continue;
    }

    if (!/\s/.test(ch)) lastSignificant = ch;
    push(ch);
    i++;
  }

  return { code: out.join(''), literals };
}

const problems: string[] = [];

// ---------------------------------------------------------------------------
// Check 1 — every `speech:` in index.ts comes from canned() or approvedSpeech
// ---------------------------------------------------------------------------

const indexPath = join(PIPELINE_DIR, 'index.ts');
const indexSrc = readFileSync(indexPath, 'utf8');
const indexScan = scan(indexSrc);

const speechAssignments = [...indexScan.code.matchAll(/\bspeech\s*:/g)];
if (speechAssignments.length === 0) {
  problems.push(
    `${indexPath}: no \`speech:\` assignment found — the invariant check ` +
      `cannot verify a response path it cannot see.`,
  );
}

for (const m of speechAssignments) {
  const start = (m.index ?? 0) + m[0].length;
  // Take the expression up to the terminating comma or newline.
  const tail = indexScan.code.slice(start, start + 200);
  const expr = (tail.split(/,\s*\n|\n/)[0] ?? '').trim();
  const lineNo = indexScan.code.slice(0, start).split('\n').length;
  if (!ALLOWED_SPEECH.test(expr)) {
    problems.push(
      `${indexPath}:${lineNo}: \`speech:\` is assigned from \`${expr}\`. ` +
        `Only \`canned(...)\` or \`approvedSpeech\` (post output-gate PASS) ` +
        `are allowed.`,
    );
  }
}

if (!/from\s+['"]\.\/canned\.ts['"]/.test(indexScan.code)) {
  problems.push(
    `${indexPath}: does not import from ./canned.ts — canned lines must come ` +
      `from the approved module, not be re-declared.`,
  );
}

// ---------------------------------------------------------------------------
// Check 2 — no long string literals anywhere in src/pipeline except canned.ts
// ---------------------------------------------------------------------------

for (const name of readdirSync(PIPELINE_DIR)) {
  if (!name.endsWith('.ts') || name === CANNED_FILE) continue;
  const path = join(PIPELINE_DIR, name);
  const src = readFileSync(path, 'utf8');
  const { literals } = scan(src);
  const lines = src.split('\n');
  for (const lit of literals) {
    if (lit.value.length <= MAX_LITERAL) continue;
    const lineText = lines[lit.line - 1] ?? '';
    if (lineText.includes(EXEMPT_MARKER)) continue;
    problems.push(
      `${path}:${lit.line}: string literal of ${lit.value.length} chars ` +
        `(limit ${MAX_LITERAL}): ${JSON.stringify(lit.value.slice(0, 60))}. ` +
        `Speakable text belongs in canned.ts or a prompt file.`,
    );
  }
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error('canned-invariant: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\n${problems.length} violation(s). Nothing may be spoken to the child ` +
      `that did not come from canned.ts or pass the output gate.`,
  );
  process.exit(1);
}

console.log('canned-invariant: OK');
