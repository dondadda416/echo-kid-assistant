/**
 * Parent review page (spec §10).
 *
 * Server-rendered HTML, no client-side JavaScript, no external fonts, no
 * third-party anything. Auth required; unauthenticated requests go to
 * /parent/login.
 *
 * SECURITY: every value that came out of the database — the child's words,
 * model drafts, canned ids, session ids — is untrusted and MUST be passed
 * through `esc()` before it is interpolated. Nothing in this file may build
 * HTML from database content any other way.
 */

import type { ExchangeFlag, MemoryLine } from '../../src/types.js';
import {
  getStore,
  type ReviewStore,
  type SessionSummary,
  type StoredExchange,
} from '../../src/memory/db.js';
import { sessionDurationMinutes } from '../../src/memory/session.js';
import {
  isAuthenticated,
  readBody,
  redirect,
  sendHtml,
  type ParentRequest,
  type ParentResponse,
} from './auth.js';

// ---------------------------------------------------------------------------
// Escaping — the single funnel for every piece of untrusted content
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * HTML-escape any value. Handles `& < > " ' \`` and stringifies non-strings.
 * `&` is replaced by the same pass, so entities are never double-built.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s.replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);
}

/** Short, stable date rendering without pulling in a library. */
export function fmtDate(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

export interface PageData {
  flagged: StoredExchange[];
  sessions: SessionSummary[];
  memory: MemoryLine[];
  detail: { session: SessionSummary | null; rows: StoredExchange[] } | null;
  notice?: string | null;
}

/** distress → redirected → gate_fail → error (spec §10). */
const FLAG_ORDER: Record<ExchangeFlag, number> = {
  distress: 0,
  redirected: 1,
  gate_fail: 2,
  error: 3,
  none: 4,
};

export function orderFlagged(rows: readonly StoredExchange[]): StoredExchange[] {
  return [...rows].sort((a, b) => {
    const d = FLAG_ORDER[a.audit.flag] - FLAG_ORDER[b.audit.flag];
    if (d !== 0) return d;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STYLES = `
:root{color-scheme:light dark;
  --bg:#f6f6f4;--fg:#1c1c1a;--muted:#5f6360;--card:#ffffff;--line:#e2e2dd;
  --red:#b3261e;--redbg:#fdecea;--amber:#8a5a00;--amberbg:#fdf3e0;
  --blue:#1c4f8a;--bluebg:#e9f0f9;--grey:#4a4a48;--greybg:#ececeb;}
@media (prefers-color-scheme:dark){:root{
  --bg:#16171a;--fg:#e8e8e6;--muted:#a0a3a6;--card:#1e2024;--line:#2c2f34;
  --red:#ff8a80;--redbg:#3a1c1a;--amber:#ffcc80;--amberbg:#332616;
  --blue:#9dc4f0;--bluebg:#182635;--grey:#c6c6c4;--greybg:#26282c;}}
*{box-sizing:border-box}
body{margin:0;padding:0 0 3rem;background:var(--bg);color:var(--fg);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
.wrap{max-width:820px;margin:0 auto;padding:1rem;}
h1{font-size:1.35rem;margin:.4rem 0 1rem}
h2{font-size:1.05rem;margin:1.6rem 0 .6rem;text-transform:uppercase;
  letter-spacing:.06em;color:var(--muted)}
h3{font-size:.95rem;margin:0 0 .3rem}
a{color:inherit}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:.75rem .85rem;margin:.5rem 0;overflow-wrap:anywhere}
.tag{display:inline-block;font-size:.72rem;font-weight:600;letter-spacing:.04em;
  padding:.12rem .45rem;border-radius:5px;margin:0 .3rem .25rem 0;
  background:var(--greybg);color:var(--grey)}
.tag.distress{background:var(--redbg);color:var(--red)}
.tag.gate_fail{background:var(--amberbg);color:var(--amber)}
.tag.redirected{background:var(--bluebg);color:var(--blue)}
.tag.error{background:var(--greybg);color:var(--grey)}
.card.distress{border-left:4px solid var(--red)}
.card.gate_fail{border-left:4px solid var(--amber)}
.card.redirected{border-left:4px solid var(--blue)}
.card.error{border-left:4px solid var(--grey)}
.meta{color:var(--muted);font-size:.8rem}
.said{margin:.35rem 0}
.said b{color:var(--muted);font-weight:600;font-size:.78rem;
  text-transform:uppercase;letter-spacing:.05em;display:block}
details{margin-top:.5rem}
summary{cursor:pointer;color:var(--muted);font-size:.85rem}
pre{white-space:pre-wrap;word-break:break-word;background:var(--greybg);
  padding:.5rem;border-radius:6px;font-size:.82rem;margin:.4rem 0 0}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{text-align:left;padding:.45rem .4rem;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase}
button{font:inherit;font-size:.82rem;padding:.25rem .6rem;border-radius:6px;
  border:1px solid var(--line);background:var(--greybg);color:var(--fg);cursor:pointer}
form.inline{display:inline}
.mem{display:flex;gap:.6rem;align-items:center;justify-content:space-between}
.reminder{background:var(--amberbg);color:var(--amber);border:1px solid var(--line);
  border-radius:10px;padding:.75rem .85rem;margin:1.5rem 0 0;font-size:.9rem}
.empty{color:var(--muted);font-style:italic;padding:.4rem 0}
.notice{background:var(--bluebg);color:var(--blue);border-radius:8px;
  padding:.5rem .7rem;margin:.5rem 0;font-size:.9rem}
`;

const REMINDER_TEXT =
  'Check the Alexa app → More → Skills & Games → Your Skills for anything ' +
  'enabled that you didn’t add. (Amazon has no toggle preventing skills from being ' +
  'enabled by voice.)';

function tag(flag: ExchangeFlag): string {
  return `<span class="tag ${esc(flag)}">${esc(flag)}</span>`;
}

function verdictTags(e: StoredExchange): string {
  const a = e.audit;
  const bits: string[] = [
    `<span class="tag">in: ${esc(a.inputVerdict)} / ${esc(a.inputReason)}</span>`,
  ];
  if (a.outputVerdict) {
    bits.push(`<span class="tag">out: ${esc(a.outputVerdict)}</span>`);
  }
  if (e.cannedId) bits.push(`<span class="tag">canned: ${esc(e.cannedId)}</span>`);
  if (a.containsPII) bits.push('<span class="tag">pii</span>');
  if (a.error) bits.push(`<span class="tag error">error</span>`);
  bits.push(tag(a.flag));
  return bits.join('');
}

function blockedBlock(e: StoredExchange): string {
  const a = e.audit;
  if (!a.generationText && !a.error && !a.inputRaw && !a.outputRaw) return '';
  const parts: string[] = [];
  if (a.generationText && a.generationText !== e.spoken) {
    parts.push(
      `<b>Model draft (not spoken)</b><pre>${esc(a.generationText)}</pre>`,
    );
  }
  if (a.inputRaw) parts.push(`<b>Input gate raw</b><pre>${esc(a.inputRaw)}</pre>`);
  if (a.outputRaw) parts.push(`<b>Output gate raw</b><pre>${esc(a.outputRaw)}</pre>`);
  if (a.error) parts.push(`<b>Error</b><pre>${esc(a.error)}</pre>`);
  if (parts.length === 0) return '';
  return `<details><summary>what was blocked</summary>${parts.join('')}</details>`;
}

function exchangeCard(e: StoredExchange, opts: { link: boolean }): string {
  const link = opts.link
    ? ` &middot; <a href="/parent?session=${esc(encodeURIComponent(e.sessionId))}">session</a>`
    : '';
  return `<div class="card ${esc(e.audit.flag)}">
  <div class="meta">${esc(fmtDate(e.createdAt))}${link}</div>
  <div class="said"><b>She said</b>${esc(e.utterance)}</div>
  <div class="said"><b>Spoken</b>${esc(e.spoken)}</div>
  <div>${verdictTags(e)}</div>
  ${blockedBlock(e)}
</div>`;
}

function flaggedStrip(rows: readonly StoredExchange[]): string {
  if (rows.length === 0) {
    return '<div class="empty">Nothing flagged in the last 7 days.</div>';
  }
  return orderFlagged(rows)
    .map((e) => exchangeCard(e, { link: true }))
    .join('\n');
}

function sessionsTable(sessions: readonly SessionSummary[]): string {
  if (sessions.length === 0) return '<div class="empty">No sessions yet.</div>';
  const rows = sessions
    .map((s) => {
      const flags = (['distress', 'redirected', 'gate_fail', 'error'] as ExchangeFlag[])
        .filter((f) => (s.flagCounts[f] ?? 0) > 0)
        .map((f) => `<span class="tag ${esc(f)}">${esc(f)} ${esc(s.flagCounts[f])}</span>`)
        .join('');
      return `<tr>
  <td><a href="/parent?session=${esc(encodeURIComponent(s.sessionId))}">${esc(fmtDate(s.startedAt))}</a></td>
  <td>${esc(sessionDurationMinutes(s))} min</td>
  <td>${esc(s.turnCount)}</td>
  <td>${s.capHit ? 'yes' : 'no'}</td>
  <td>${flags || '<span class="meta">clean</span>'}</td>
</tr>`;
    })
    .join('\n');
  return `<table>
<thead><tr><th>Date</th><th>Duration</th><th>Turns</th><th>Cap hit</th><th>Flags</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function transcript(detail: PageData['detail']): string {
  if (!detail) return '';
  const s = detail.session;
  const head = s
    ? `<div class="meta">${esc(fmtDate(s.startedAt))} &middot; ${esc(sessionDurationMinutes(s))} min &middot; ${esc(s.turnCount)} turns${s.capHit ? ' &middot; cap hit' : ''}</div>`
    : '';
  const body =
    detail.rows.length === 0
      ? '<div class="empty">No turns recorded for this session.</div>'
      : detail.rows.map((e) => exchangeCard(e, { link: false })).join('\n');
  return `<h2>Session transcript</h2>
${head}
${body}
<p><a href="/parent">&larr; back to all sessions</a></p>`;
}

function memoryPanel(lines: readonly MemoryLine[]): string {
  if (lines.length === 0) {
    return '<div class="empty">No stored memory lines.</div>';
  }
  return lines
    .map(
      (m) => `<div class="card mem">
  <div>${esc(m.line)}<div class="meta">${esc(fmtDate(m.createdAt))}</div></div>
  <form class="inline" method="POST" action="/parent">
    <input type="hidden" name="action" value="delete_memory">
    <input type="hidden" name="id" value="${esc(m.id)}">
    <input type="hidden" name="userId" value="${esc(m.userId)}">
    <button type="submit">Delete</button>
  </form>
</div>`,
    )
    .join('\n');
}

/** Render the whole page. Pure — takes data, returns HTML. */
export function renderPage(data: PageData): string {
  const notice = data.notice
    ? `<div class="notice">${esc(data.notice)}</div>`
    : '';
  const main = data.detail
    ? transcript(data.detail)
    : `<h2>Flagged, last 7 days</h2>
${flaggedStrip(data.flagged)}
<h2>Sessions</h2>
${sessionsTable(data.sessions)}`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Helper — parent review</title>
<style>${STYLES}</style>
</head><body><div class="wrap">
<h1>Helper — parent review</h1>
${notice}
${main}
<h2>Memory</h2>
${memoryPanel(data.memory)}
<div class="reminder">${esc(REMINDER_TEXT)}</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function queryOf(req: ParentRequest): URLSearchParams {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.slice(q + 1) : '');
}

export async function loadPageData(
  store: ReviewStore,
  sessionId: string | null,
  notice: string | null,
): Promise<PageData> {
  const [flagged, sessions, memory] = await Promise.all([
    store.listFlagged(7),
    store.listSessions(50),
    store.listAllMemory(),
  ]);
  let detail: PageData['detail'] = null;
  if (sessionId) {
    const rows = await store.loadTranscript(sessionId);
    detail = {
      session: sessions.find((s) => s.sessionId === sessionId) ?? null,
      rows,
    };
  }
  return { flagged, sessions, memory, detail, notice };
}

export default async function handler(
  req: ParentRequest,
  res: ParentResponse,
): Promise<void> {
  if (!isAuthenticated(req)) {
    redirect(res, '/parent/login');
    return;
  }

  let store: ReviewStore;
  try {
    store = getStore();
  } catch (err) {
    console.error('parent page: no store', err);
    sendHtml(
      res,
      500,
      renderPage({
        flagged: [],
        sessions: [],
        memory: [],
        detail: null,
        notice: 'The database is not configured (DATABASE_URL is missing).',
      }),
    );
    return;
  }

  let notice: string | null = null;

  if ((req.method ?? 'GET').toUpperCase() === 'POST') {
    try {
      const body = await readBody(req);
      if (body['action'] === 'delete_memory') {
        const id = Number(body['id']);
        const userId = body['userId'] ?? '';
        if (Number.isInteger(id) && id > 0 && userId) {
          await store.deleteMemoryLine(userId, id);
          notice = 'Memory line deleted.';
        } else {
          notice = 'Could not delete that memory line.';
        }
      }
    } catch (err) {
      console.error('parent page: action failed', err);
      notice = 'That action did not work.';
    }
  }

  try {
    const sessionId = queryOf(req).get('session');
    const data = await loadPageData(store, sessionId, notice);
    sendHtml(res, 200, renderPage(data));
  } catch (err) {
    console.error('parent page: render failed', err);
    sendHtml(
      res,
      500,
      renderPage({
        flagged: [],
        sessions: [],
        memory: [],
        detail: null,
        notice: 'Could not load the log.',
      }),
    );
  }
}
