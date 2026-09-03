/**
 * Parent login (spec §10).
 *
 * GET  → a minimal form.
 * POST → constant-time password check, signed cookie, redirect to /parent.
 *
 * Wrong password and rate-limited attempts get the same generic message. The
 * page never says whether the password was wrong, whether one is configured,
 * or how many attempts remain.
 */

import {
  clientIp,
  isAuthenticated,
  makeSessionToken,
  readBody,
  redirect,
  registerAttempt,
  resetAttempts,
  sendHtml,
  sessionCookie,
  verifyPassword,
  type ParentRequest,
  type ParentResponse,
} from './auth.ts';
import { esc } from './index.ts';

const GENERIC_ERROR = 'That did not work. Try again.';

const STYLES = `
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--card:#fff;
  --line:#e2e2dd;--muted:#5f6360;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e8e8e6;--card:#1e2024;
  --line:#2c2f34;--muted:#a0a3a6;--err:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;
  justify-content:center;background:var(--bg);color:var(--fg);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:1.4rem;width:min(360px,92vw);display:flex;flex-direction:column;gap:.7rem}
h1{font-size:1.1rem;margin:0 0 .3rem}
label{font-size:.85rem;color:var(--muted)}
input{font:inherit;padding:.6rem;border-radius:8px;border:1px solid var(--line);
  background:var(--bg);color:var(--fg);width:100%}
button{font:inherit;padding:.6rem;border-radius:8px;border:1px solid var(--line);
  background:var(--fg);color:var(--bg);cursor:pointer}
.err{color:var(--err);font-size:.85rem;margin:0}
`;

/** Render the login form. `error` is always the generic message or null. */
export function renderLogin(error: string | null): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Helper — parent review</title>
<style>${STYLES}</style>
</head><body>
<form method="POST" action="/parent/login" autocomplete="off">
  <h1>Parent review</h1>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>
</body></html>`;
}

export default async function handler(
  req: ParentRequest,
  res: ParentResponse,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET') {
    if (isAuthenticated(req)) {
      redirect(res, '/parent');
      return;
    }
    sendHtml(res, 200, renderLogin(null));
    return;
  }

  if (method !== 'POST') {
    sendHtml(res, 405, renderLogin(null));
    return;
  }

  const ip = clientIp(req);
  const limit = registerAttempt(ip);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    sendHtml(res, 429, renderLogin(GENERIC_ERROR));
    return;
  }

  let password = '';
  try {
    const body = await readBody(req);
    password = body['password'] ?? '';
  } catch {
    password = '';
  }

  if (!verifyPassword(password)) {
    sendHtml(res, 401, renderLogin(GENERIC_ERROR));
    return;
  }

  resetAttempts(ip);
  redirect(res, '/parent', sessionCookie(makeSessionToken()));
}
