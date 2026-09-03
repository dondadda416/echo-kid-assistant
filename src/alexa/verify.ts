/**
 * Alexa request verification — the security boundary of this service.
 *
 * Without this, anyone on the internet could POST a crafted request to
 * /api/alexa and talk to the child through her Echo. Everything here is
 * fail-closed: any error, any ambiguity, any parse failure is a rejection.
 *
 * `ask-sdk-express-adapter` (which ships Amazon's own
 * `SkillRequestSignatureVerifier` / `TimestampVerifier`) is NOT installed in
 * this repo, so the documented algorithm is implemented directly on top of
 * node:crypto here. See docs/T2-NOTES.md.
 *
 * CRITICAL: the signature covers the RAW request body bytes exactly as sent.
 * It must be verified before JSON.parse, and never against a re-serialised
 * object — round-tripping through JSON.parse/stringify changes whitespace and
 * key order and would make every signature fail (or, worse, tempt someone to
 * "fix" it by skipping verification).
 */

import crypto from 'node:crypto';

/** Amazon's documented tolerance. Anything older is a replay. */
const TIMESTAMP_TOLERANCE_MS = 150_000;

const SIGNATURE_CERT_CHAIN_URL_HEADER = 'signaturecertchainurl';
const SIGNATURE_256_HEADER = 'signature-256';
const SIGNATURE_LEGACY_HEADER = 'signature';

const CERT_CHAIN_HOST = 's3.amazonaws.com';
const CERT_CHAIN_PATH_PREFIX = '/echo.api/';
const ECHO_SAN = 'echo-api.amazon.com';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Fetched PEM chains, keyed by certificate chain URL. Cold-start cache. */
const certCache = new Map<string, crypto.X509Certificate[]>();

/** Test seam: swap the network fetcher. Returns the PEM chain as text. */
let fetchPem: (url: string) => Promise<string> = defaultFetchPem;

/** For unit tests only. Pass `null` to restore the real network fetcher. */
export function __setCertFetcher(
  fn: ((url: string) => Promise<string>) | null,
): void {
  fetchPem = fn ?? defaultFetchPem;
  certCache.clear();
}

async function defaultFetchPem(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`cert fetch status ${res.status}`);
  return await res.text();
}

function header(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const v = headers[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return undefined;
}

/**
 * Validate the cert chain URL shape per Amazon's rules:
 * https, host s3.amazonaws.com (case-insensitive), normalised path starting
 * with /echo.api/, port 443 or absent.
 */
export function validateCertChainUrl(raw: string): VerifyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'cert_url_unparseable' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'cert_url_not_https' };
  if (url.hostname.toLowerCase() !== CERT_CHAIN_HOST) {
    return { ok: false, reason: 'cert_url_bad_host' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, reason: 'cert_url_bad_port' };
  }
  // Normalise away '..' / '.' segments and duplicate slashes before the check.
  const segments: string[] = [];
  for (const seg of url.pathname.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  const normalised = `/${segments.join('/')}`;
  if (!normalised.startsWith(CERT_CHAIN_PATH_PREFIX)) {
    return { ok: false, reason: 'cert_url_bad_path' };
  }
  return { ok: true };
}

function parsePemChain(pem: string): crypto.X509Certificate[] {
  const blocks = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (!blocks || blocks.length === 0) return [];
  return blocks.map((b) => new crypto.X509Certificate(b));
}

async function loadChain(url: string): Promise<crypto.X509Certificate[]> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const pem = await fetchPem(url);
  const chain = parsePemChain(pem);
  if (chain.length === 0) throw new Error('empty cert chain');
  certCache.set(url, chain);
  return chain;
}

function validateChain(
  chain: crypto.X509Certificate[],
  now: number,
): VerifyResult {
  const leaf = chain[0];
  if (!leaf) return { ok: false, reason: 'cert_chain_empty' };

  const from = Date.parse(leaf.validFrom);
  const to = Date.parse(leaf.validTo);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return { ok: false, reason: 'cert_validity_unparseable' };
  }
  if (now < from || now > to) return { ok: false, reason: 'cert_expired' };

  if (!leaf.checkHost(ECHO_SAN)) return { ok: false, reason: 'cert_san_missing' };

  // Each certificate must be issued and signed by the next one up.
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!child || !parent) return { ok: false, reason: 'cert_chain_broken' };
    if (!child.checkIssued(parent)) return { ok: false, reason: 'cert_chain_broken' };
    try {
      if (!child.verify(parent.publicKey)) {
        return { ok: false, reason: 'cert_chain_signature_invalid' };
      }
    } catch {
      return { ok: false, reason: 'cert_chain_signature_invalid' };
    }
  }
  return { ok: true };
}

/** Envelope fields we need before the body can be trusted. Read defensively. */
interface MinimalEnvelope {
  request?: { timestamp?: unknown };
  session?: { application?: { applicationId?: unknown } };
  context?: { System?: { application?: { applicationId?: unknown } } };
}

function checkTimestamp(env: MinimalEnvelope, now: number): VerifyResult {
  const ts = env.request?.timestamp;
  if (typeof ts !== 'string' || ts.length === 0) {
    return { ok: false, reason: 'timestamp_missing' };
  }
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return { ok: false, reason: 'timestamp_unparseable' };
  if (Math.abs(now - parsed) > TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  return { ok: true };
}

function checkApplicationId(env: MinimalEnvelope): VerifyResult {
  const expected = process.env['ALEXA_SKILL_ID'];
  if (!expected) return { ok: true };
  const fromSession = env.session?.application?.applicationId;
  const fromContext = env.context?.System?.application?.applicationId;
  const actual =
    typeof fromSession === 'string'
      ? fromSession
      : typeof fromContext === 'string'
        ? fromContext
        : undefined;
  if (actual === undefined) return { ok: false, reason: 'application_id_missing' };
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'application_id_mismatch' };
  }
  return { ok: true };
}

/**
 * Verify a request from Alexa.
 *
 * @param rawBody the request body exactly as received, before JSON.parse.
 * @param headers request headers (any casing).
 */
export async function verifyAlexaRequest(
  rawBody: string,
  headers: Record<string, string | undefined>,
): Promise<VerifyResult> {
  try {
    const certUrl = header(headers, SIGNATURE_CERT_CHAIN_URL_HEADER);
    if (!certUrl) return { ok: false, reason: 'cert_chain_url_header_missing' };

    const sig256 = header(headers, SIGNATURE_256_HEADER);
    const sigLegacy = header(headers, SIGNATURE_LEGACY_HEADER);
    const signature = sig256 ?? sigLegacy;
    if (!signature) return { ok: false, reason: 'signature_header_missing' };
    // signature-256 is RSA-SHA256; the deprecated `Signature` header is SHA1.
    const algorithm = sig256 ? 'RSA-SHA256' : 'RSA-SHA1';

    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      return { ok: false, reason: 'empty_body' };
    }

    const urlCheck = validateCertChainUrl(certUrl);
    if (!urlCheck.ok) return urlCheck;

    // Cheap checks that need the body parsed. The body is still untrusted at
    // this point; nothing derived from it is used before the signature check
    // below succeeds, and the caller must not dispatch on a failure.
    let env: MinimalEnvelope;
    try {
      env = JSON.parse(rawBody) as MinimalEnvelope;
    } catch {
      return { ok: false, reason: 'body_not_json' };
    }
    if (env === null || typeof env !== 'object') {
      return { ok: false, reason: 'body_not_json' };
    }

    const now = Date.now();
    const tsCheck = checkTimestamp(env, now);
    if (!tsCheck.ok) return tsCheck;

    const appCheck = checkApplicationId(env);
    if (!appCheck.ok) return appCheck;

    let chain: crypto.X509Certificate[];
    try {
      chain = await loadChain(certUrl);
    } catch {
      return { ok: false, reason: 'cert_fetch_failed' };
    }

    const chainCheck = validateChain(chain, now);
    if (!chainCheck.ok) return chainCheck;

    const leaf = chain[0];
    if (!leaf) return { ok: false, reason: 'cert_chain_empty' };

    // Signature is over the RAW bytes, not a re-serialised object.
    const verifier = crypto.createVerify(algorithm);
    verifier.update(Buffer.from(rawBody, 'utf8'));
    verifier.end();
    let valid = false;
    try {
      valid = verifier.verify(leaf.publicKey, signature, 'base64');
    } catch {
      return { ok: false, reason: 'signature_invalid' };
    }
    if (!valid) return { ok: false, reason: 'signature_invalid' };

    return { ok: true };
  } catch {
    // Fail closed on anything unexpected.
    return { ok: false, reason: 'verification_error' };
  }
}
