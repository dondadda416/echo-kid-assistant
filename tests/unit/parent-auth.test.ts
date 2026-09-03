import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCookie,
  clientIp,
  constantTimeEqual,
  COOKIE_NAME,
  isAuthenticated,
  isConfigured,
  makeSessionToken,
  parseCookies,
  parseFormBody,
  RATE_LIMIT_MAX,
  registerAttempt,
  resetAllAttempts,
  resetAttempts,
  sessionCookie,
  SESSION_TTL_MS,
  verifyPassword,
  verifySessionToken,
  type ParentRequest,
  type ParentResponse,
} from '../../api/parent/auth.ts';
import loginHandler, { renderLogin } from '../../api/parent/login.ts';
import { esc, fmtDate, orderFlagged, renderPage } from '../../api/parent/index.ts';
import type { StoredExchange } from '../../src/memory/db.ts';
import type { TurnAudit } from '../../src/types.ts';

const PASSWORD = 'correct horse battery staple';

beforeEach(() => {
  process.env['PARENT_PASSWORD'] = PASSWORD;
  delete process.env['SESSION_SECRET'];
  resetAllAttempts();
});

afterEach(() => {
  delete process.env['PARENT_PASSWORD'];
  resetAllAttempts();
});

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function fakeRes(): ParentResponse & { headers: Record<string, string | string[]>; body: string } {
  return {
    statusCode: 200,
    headers: {} as Record<string, string | string[]>,
    body: '',
    setHeader(name: string, value: string | string[]) {
      this.headers[name] = value;
    },
    end(body?: string) {
      this.body = body ?? '';
    },
  };
}

function fakeReq(over: Partial<ParentRequest> = {}): ParentRequest {
  return {
    method: 'GET',
    url: '/parent/login',
    headers: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('password check', () => {
  it('accepts the configured password', () => {
    expect(verifyPassword(PASSWORD)).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(verifyPassword('wrong')).toBe(false);
    expect(verifyPassword(PASSWORD + ' ')).toBe(false);
    expect(verifyPassword(PASSWORD.slice(0, -1))).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(verifyPassword('')).toBe(false);
    expect(verifyPassword(undefined)).toBe(false);
    expect(verifyPassword(null)).toBe(false);
    expect(verifyPassword({ toString: () => PASSWORD })).toBe(false);
  });

  it('rejects everything when no password is configured', () => {
    delete process.env['PARENT_PASSWORD'];
    expect(isConfigured()).toBe(false);
    expect(verifyPassword('')).toBe(false);
    expect(verifyPassword('anything')).toBe(false);
  });

  it('constant-time compare handles length mismatch without throwing', () => {
    expect(() => constantTimeEqual('a', 'a much longer value')).not.toThrow();
    expect(constantTimeEqual('a', 'a much longer value')).toBe(false);
    expect(constantTimeEqual('same', 'same')).toBe(true);
  });
});

describe('session cookie', () => {
  it('is HttpOnly, Secure, SameSite=Strict and path-scoped', () => {
    const cookie = sessionCookie(makeSessionToken());
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
  });

  it('clearCookie expires immediately and keeps the flags', () => {
    expect(clearCookie()).toMatch(/Max-Age=0/);
    expect(clearCookie()).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  });

  it('round-trips a valid token', () => {
    expect(verifySessionToken(makeSessionToken())).toBe(true);
  });

  it('rejects a forged signature', () => {
    const token = makeSessionToken();
    const [exp] = token.split('.');
    const forged = `${exp}.${'a'.repeat(64)}`;
    expect(verifySessionToken(forged)).toBe(false);
  });

  it('rejects a tampered expiry', () => {
    const token = makeSessionToken();
    const mac = token.split('.')[1]!;
    expect(verifySessionToken(`${Date.now() + 10 * SESSION_TTL_MS}.${mac}`)).toBe(false);
  });

  it('rejects an unsigned or malformed token', () => {
    expect(verifySessionToken('')).toBe(false);
    expect(verifySessionToken('true')).toBe(false);
    expect(verifySessionToken('.abc')).toBe(false);
    expect(verifySessionToken('123.')).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
    expect(verifySessionToken({} as unknown)).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = makeSessionToken(Date.now() - 2 * SESSION_TTL_MS);
    expect(verifySessionToken(token)).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    process.env['SESSION_SECRET'] = 'secret-a';
    const token = makeSessionToken();
    process.env['SESSION_SECRET'] = 'secret-b';
    expect(verifySessionToken(token)).toBe(false);
  });

  it('isAuthenticated reads the cookie header', () => {
    const token = makeSessionToken();
    expect(
      isAuthenticated(fakeReq({ headers: { cookie: `${COOKIE_NAME}=${token}` } })),
    ).toBe(true);
    expect(
      isAuthenticated(fakeReq({ headers: { cookie: `${COOKIE_NAME}=nope` } })),
    ).toBe(false);
    expect(isAuthenticated(fakeReq())).toBe(false);
  });

  it('parseCookies handles multiple cookies and encoding', () => {
    const c = parseCookies('a=1; b=hello%20there; parent_session=xyz');
    expect(c['a']).toBe('1');
    expect(c['b']).toBe('hello there');
    expect(c['parent_session']).toBe('xyz');
  });
});

describe('rate limit', () => {
  it('allows 5 attempts then rejects', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(registerAttempt('1.2.3.4').allowed).toBe(true);
    }
    const sixth = registerAttempt('1.2.3.4');
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSec).toBeGreaterThan(0);
  });

  it('is per IP', () => {
    for (let i = 0; i < 6; i++) registerAttempt('1.1.1.1');
    expect(registerAttempt('2.2.2.2').allowed).toBe(true);
  });

  it('resets after a successful login', () => {
    for (let i = 0; i < 5; i++) registerAttempt('3.3.3.3');
    resetAttempts('3.3.3.3');
    expect(registerAttempt('3.3.3.3').allowed).toBe(true);
  });

  it('reopens after the window', () => {
    const now = Date.now();
    for (let i = 0; i < 6; i++) registerAttempt('4.4.4.4', now);
    expect(registerAttempt('4.4.4.4', now + 16 * 60_000).allowed).toBe(true);
  });

  it('clientIp prefers x-forwarded-for', () => {
    expect(clientIp(fakeReq({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }))).toBe('9.9.9.9');
    expect(clientIp(fakeReq({ socket: { remoteAddress: '8.8.8.8' } }))).toBe('8.8.8.8');
    expect(clientIp(fakeReq())).toBe('unknown');
  });
});

describe('login handler', () => {
  it('GET renders a form with a password field', async () => {
    const res = fakeRes();
    await loginHandler(fakeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="password"');
    expect(res.body).toContain('type="password"');
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('POST with the right password sets the cookie and redirects', async () => {
    const res = fakeRes();
    await loginHandler(
      fakeReq({ method: 'POST', body: `password=${encodeURIComponent(PASSWORD)}` }),
      res,
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers['Location']).toBe('/parent');
    const cookie = String(res.headers['Set-Cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('POST with a wrong password gives a generic error and no cookie', async () => {
    const res = fakeRes();
    await loginHandler(fakeReq({ method: 'POST', body: 'password=nope' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(res.body).toContain('That did not work.');
    expect(res.body).not.toContain(PASSWORD);
    expect(res.body.toLowerCase()).not.toContain('incorrect password');
  });

  it('engages the rate limit after 5 attempts from one IP', async () => {
    const headers = { 'x-forwarded-for': '5.5.5.5' };
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      await loginHandler(fakeReq({ method: 'POST', headers, body: 'password=nope' }), res);
      expect(res.statusCode).toBe(401);
    }
    const blocked = fakeRes();
    await loginHandler(
      fakeReq({ method: 'POST', headers, body: `password=${encodeURIComponent(PASSWORD)}` }),
      blocked,
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['Retry-After']).toBeDefined();
    expect(blocked.headers['Set-Cookie']).toBeUndefined();
  });

  it('sets no-store and anti-framing headers', async () => {
    const res = fakeRes();
    await loginHandler(fakeReq(), res);
    expect(String(res.headers['Cache-Control'])).toContain('no-store');
    expect(res.headers['X-Frame-Options']).toBe('DENY');
  });

  it('renderLogin escapes whatever error it is given', () => {
    expect(renderLogin('<script>x</script>')).not.toContain('<script>');
  });

  it('parseFormBody handles strings, buffers and pre-parsed objects', () => {
    expect(parseFormBody('password=a%20b')['password']).toBe('a b');
    expect(parseFormBody(Buffer.from('password=xyz'))['password']).toBe('xyz');
    expect(parseFormBody({ password: 'obj' })['password']).toBe('obj');
    expect(parseFormBody(null)).toEqual({});
  });
});

describe('parent page — auth gate', () => {
  it('an unauthenticated request is redirected to the login page', async () => {
    const { default: pageHandler } = await import('../../api/parent/index.ts');
    const res = fakeRes();
    await pageHandler(fakeReq({ url: '/parent' }), res);
    expect(res.statusCode).toBe(302);
    expect(res.headers['Location']).toBe('/parent/login');
  });

  it('a forged cookie does not get in', async () => {
    const { default: pageHandler } = await import('../../api/parent/index.ts');
    const res = fakeRes();
    await pageHandler(
      fakeReq({ url: '/parent', headers: { cookie: `${COOKIE_NAME}=${Date.now() + 99999}.${'f'.repeat(64)}` } }),
      res,
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers['Location']).toBe('/parent/login');
  });
});

describe('esc()', () => {
  it('neutralizes a script tag', () => {
    const out = esc('<script>alert("xss")</script>');
    expect(out).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('escapes quotes so attributes cannot be broken out of', () => {
    expect(esc('" onmouseover="alert(1)')).toBe('&quot; onmouseover=&quot;alert(1)');
    expect(esc("' onfocus='alert(1)")).toBe('&#39; onfocus=&#39;alert(1)');
    expect(esc('`backtick`')).toBe('&#96;backtick&#96;');
  });

  it('escapes ampersands first so entities are not double-decoded', () => {
    expect(esc('Skills & Games')).toBe('Skills &amp; Games');
    expect(esc('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('stringifies non-strings and blanks null/undefined', () => {
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(true)).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// page rendering
// ---------------------------------------------------------------------------

function audit(over: Partial<TurnAudit> = {}): TurnAudit {
  return {
    inputVerdict: 'OK',
    inputReason: 'clean',
    inputRaw: 'OK',
    generationText: 'draft',
    outputVerdict: 'PASS',
    outputRaw: 'PASS',
    flag: 'none',
    containsPII: false,
    timings: { inputGateMs: 1, generationMs: 2, outputGateMs: 3, totalMs: 6 },
    models: { gate: 'g', generation: 'm' },
    error: null,
    ...over,
  };
}

function exchange(over: Partial<StoredExchange> = {}): StoredExchange {
  return {
    id: 1,
    sessionId: 's1',
    userId: 'u1',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    utterance: 'why do horses sleep standing up',
    spoken: 'Because their legs lock.',
    cannedId: null,
    audit: audit(),
    ...over,
  };
}

describe('parent page rendering', () => {
  it('orders the flagged strip distress → redirected → gate_fail → error', () => {
    const rows = [
      exchange({ id: 1, audit: audit({ flag: 'error' }) }),
      exchange({ id: 2, audit: audit({ flag: 'gate_fail' }) }),
      exchange({ id: 3, audit: audit({ flag: 'redirected' }) }),
      exchange({ id: 4, audit: audit({ flag: 'distress' }) }),
    ];
    expect(orderFlagged(rows).map((r) => r.audit.flag)).toEqual([
      'distress',
      'redirected',
      'gate_fail',
      'error',
    ]);
  });

  it('escapes the child’s words and the model draft', () => {
    const html = renderPage({
      flagged: [
        exchange({
          utterance: '<img src=x onerror=alert(1)>',
          spoken: '"quoted" & ampersand',
          audit: audit({ flag: 'gate_fail', generationText: '<script>bad()</script>' }),
        }),
      ],
      sessions: [],
      memory: [{ id: 1, userId: 'u1', line: '<b>likes horses</b>', createdAt: new Date() }],
      detail: null,
      notice: null,
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>bad()');
    expect(html).not.toContain('<b>likes horses</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; ampersand');
  });

  it('shows blocked generations in a details element', () => {
    const html = renderPage({
      flagged: [
        exchange({
          spoken: 'Ask Mom or Dad.',
          cannedId: 'REDIRECT',
          audit: audit({ flag: 'gate_fail', outputVerdict: 'FAIL', generationText: 'rejected draft' }),
        }),
      ],
      sessions: [],
      memory: [],
      detail: null,
      notice: null,
    });
    expect(html).toContain('what was blocked');
    expect(html).toContain('rejected draft');
    expect(html).toContain('canned: REDIRECT');
  });

  it('renders the memory panel with a delete form per line', () => {
    const html = renderPage({
      flagged: [],
      sessions: [],
      memory: [
        { id: 7, userId: 'u1', line: 'likes horses', createdAt: new Date() },
        { id: 8, userId: 'u1', line: 'enjoys riddles', createdAt: new Date() },
      ],
      detail: null,
      notice: null,
    });
    expect(html.match(/name="action" value="delete_memory"/g)).toHaveLength(2);
    expect(html).toContain('value="7"');
    expect(html).toContain('method="POST"');
  });

  it('carries the static Alexa-app reminder', () => {
    const html = renderPage({ flagged: [], sessions: [], memory: [], detail: null });
    expect(html).toContain('Skills &amp; Games');
    expect(html).toContain('Your Skills');
  });

  it('is mobile-friendly and self-contained', () => {
    const html = renderPage({ flagged: [], sessions: [], memory: [], detail: null });
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
    expect(html).toContain('prefers-color-scheme');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('renders a session transcript with both sides of each turn', () => {
    const html = renderPage({
      flagged: [],
      sessions: [],
      memory: [],
      detail: {
        session: {
          sessionId: 's1',
          userId: 'u1',
          startedAt: new Date('2026-09-01T10:00:00Z'),
          endedAt: new Date('2026-09-01T10:08:00Z'),
          turnCount: 4,
          capHit: false,
          flagCounts: { none: 4, redirected: 0, distress: 0, gate_fail: 0, error: 0 },
        },
        rows: [exchange()],
      },
      notice: null,
    });
    expect(html).toContain('She said');
    expect(html).toContain('Spoken');
    expect(html).toContain('why do horses sleep standing up');
    expect(html).toContain('8 min');
  });

  it('fmtDate never renders "Invalid Date"', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(new Date('nonsense'))).toBe('—');
    expect(fmtDate(new Date('2026-09-01T10:00:00Z'))).toBe('2026-09-01 10:00 UTC');
  });
});
