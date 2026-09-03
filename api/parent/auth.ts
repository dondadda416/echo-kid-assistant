/**
 * Parent page authentication (spec §10, §12 T6).
 *
 * One shared secret in PARENT_PASSWORD. Constant-time comparison, a signed
 * HTTP-only cookie, and a small per-IP rate limit. No user accounts, no
 * database, no third-party anything.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Minimal request/response shapes (structurally satisfied by Vercel's Node
// handler arguments — no extra dependency needed).
// ---------------------------------------------------------------------------

export interface ParentRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string | undefined } | undefined;
  on?: (event: string, cb: (chunk: unknown) => void) => unknown;
}

export interface ParentResponse {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  end(body?: string): unknown;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export const COOKIE_NAME = 'parent_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Random per-process fallback: with no PARENT_PASSWORD set, nothing authenticates. */
const UNSET_SENTINEL = randomBytes(32).toString('hex');

export function parentPassword(): string {
  const p = process.env['PARENT_PASSWORD'];
  return p && p.length > 0 ? p : UNSET_SENTINEL;
}

export function sessionSecret(): string {
  const s = process.env['SESSION_SECRET'];
  return s && s.length > 0 ? s : parentPassword();
}

/** True when the page is usable at all. */
export function isConfigured(): boolean {
  const p = process.env['PARENT_PASSWORD'];
  return typeof p === 'string' && p.length > 0;
}

// ---------------------------------------------------------------------------
// Constant-time compare
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch and the length itself leaks, so
 * both sides are hashed to a fixed 32 bytes first and the digests are compared.
 * Runtime is independent of both the length and the content of the input.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Check a submitted password against PARENT_PASSWORD. */
export function verifyPassword(submitted: unknown): boolean {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  if (!isConfigured()) return false;
  return constantTimeEqual(submitted, parentPassword());
}

// ---------------------------------------------------------------------------
// Signed session cookie
// ---------------------------------------------------------------------------

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

/** Build a cookie value of the form `<expiryMs>.<hmac>`. */
export function makeSessionToken(now: number = Date.now()): string {
  const exp = String(now + SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

/** Verify a cookie value. Any tampering, any expiry, any shape error → false. */
export function verifySessionToken(
  token: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d{1,15}$/.test(exp) || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const expected = sign(exp);
  if (!constantTimeEqual(mac, expected)) return false;
  return Number(exp) > now;
}

export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** True when the request carries a valid session cookie. */
export function isAuthenticated(req: ParentRequest, now: number = Date.now()): boolean {
  if (!isConfigured()) return false;
  const cookies = parseCookies(req.headers?.['cookie']);
  return verifySessionToken(cookies[COOKIE_NAME], now);
}

// ---------------------------------------------------------------------------
// Rate limit — 5 attempts per IP per 15 minutes
// ---------------------------------------------------------------------------

export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function clientIp(req: ParentRequest): string {
  const fwd = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof first === 'string' && first.length > 0) {
    const ip = first.split(',')[0];
    if (ip && ip.trim()) return ip.trim();
  }
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real;
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Record one login attempt. Returns false once the IP has used its 5 attempts
 * within the window. Successful logins call `resetAttempts`.
 */
export function registerAttempt(ip: string, now: number = Date.now()): {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
} {
  if (buckets.size > 10_000) buckets.clear(); // crude memory bound
  const b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(ip, fresh);
    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX - 1,
      retryAfterSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    };
  }
  b.count += 1;
  const allowed = b.count <= RATE_LIMIT_MAX;
  return {
    allowed,
    remaining: Math.max(0, RATE_LIMIT_MAX - b.count),
    retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

export function resetAttempts(ip: string): void {
  buckets.delete(ip);
}

/** Test seam. */
export function resetAllAttempts(): void {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Body parsing (form posts)
// ---------------------------------------------------------------------------

/** Parse an `application/x-www-form-urlencoded` body into a flat record. */
export function parseFormBody(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (body == null) return out;
  if (typeof body === 'object' && !(body instanceof Uint8Array) && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  const text =
    typeof body === 'string'
      ? body
      : body instanceof Uint8Array
        ? Buffer.from(body).toString('utf8')
        : String(body);
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

/** Read the raw body when the platform did not parse one. */
export async function readBody(req: ParentRequest): Promise<Record<string, string>> {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    return parseFormBody(req.body);
  }
  if (typeof req.on !== 'function') return {};
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on!('data', (c: unknown) => {
      chunks.push(Buffer.from(c as Uint8Array));
    });
    req.on!('end', () => resolve());
    req.on!('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
  });
  return parseFormBody(Buffer.concat(chunks).toString('utf8'));
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function sendHtml(
  res: ParentResponse,
  status: number,
  html: string,
  cookie?: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end(html);
}

export function redirect(res: ParentResponse, location: string, cookie?: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end('');
}
