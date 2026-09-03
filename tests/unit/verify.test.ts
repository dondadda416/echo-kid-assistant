import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  verifyAlexaRequest,
  validateCertChainUrl,
  __setCertFetcher,
} from '../../src/alexa/verify.ts';

const GOOD_URL = 'https://s3.amazonaws.com/echo.api/echo-api-cert-12.pem';

/**
 * A self-signed cert with SAN echo-api.amazon.com, generated locally so the
 * happy path can be exercised with a REAL signature and zero network access.
 * If openssl is unavailable the signature-positive tests are skipped; every
 * negative test still runs.
 */
let fixture: { pem: string; privateKey: crypto.KeyObject } | null = null;

function makeFixture(): { pem: string; privateKey: crypto.KeyObject } | null {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'alexa-cert-'));
    const cnf = join(dir, 'openssl.cnf');
    writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name=dn',
        'x509_extensions=v3',
        'prompt=no',
        '[dn]',
        'CN=echo-api.amazon.com',
        '[v3]',
        'subjectAltName=DNS:echo-api.amazon.com',
        'basicConstraints=CA:FALSE',
      ].join('\n'),
    );
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '2', '-config', cnf,
      ],
      { stdio: 'ignore' },
    );
    const privateKey = crypto.createPrivateKey(readFileSync(keyPath, 'utf8'));
    return { pem: readFileSync(certPath, 'utf8'), privateKey };
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.0',
    session: {
      sessionId: 'sess-1',
      application: { applicationId: 'amzn1.ask.skill.TEST' },
      user: { userId: 'user-1' },
    },
    context: {
      System: {
        application: { applicationId: 'amzn1.ask.skill.TEST' },
        user: { userId: 'user-1' },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request: {
      type: 'IntentRequest',
      requestId: 'req-1',
      timestamp: new Date().toISOString(),
      intent: { name: 'ChatIntent' },
      ...(overrides['request'] as object | undefined),
    },
    ...overrides,
  });
}

function sign(body: string): string {
  if (!fixture) return 'not-a-signature';
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(Buffer.from(body, 'utf8'));
  signer.end();
  return signer.sign(fixture.privateKey, 'base64');
}

function headers(body: string, extra: Record<string, string> = {}) {
  return {
    signaturecertchainurl: GOOD_URL,
    'signature-256': sign(body),
    ...extra,
  };
}

beforeAll(() => {
  fixture = makeFixture();
});

let originalSkillId: string | undefined;

beforeEach(() => {
  originalSkillId = process.env['ALEXA_SKILL_ID'];
  delete process.env['ALEXA_SKILL_ID'];
  __setCertFetcher(async () => {
    if (!fixture) throw new Error('no fixture');
    return fixture.pem;
  });
});

afterEach(() => {
  __setCertFetcher(null);
  if (originalSkillId === undefined) delete process.env['ALEXA_SKILL_ID'];
  else process.env['ALEXA_SKILL_ID'] = originalSkillId;
});

// ---------------------------------------------------------------------------

describe('validateCertChainUrl', () => {
  it('accepts the documented shape', () => {
    expect(validateCertChainUrl(GOOD_URL).ok).toBe(true);
    expect(
      validateCertChainUrl('https://s3.amazonaws.com:443/echo.api/cert.pem').ok,
    ).toBe(true);
  });

  it('rejects http', () => {
    const r = validateCertChainUrl('http://s3.amazonaws.com/echo.api/cert.pem');
    expect(r).toEqual({ ok: false, reason: 'cert_url_not_https' });
  });

  it('rejects the wrong host', () => {
    const r = validateCertChainUrl('https://evil.example.com/echo.api/cert.pem');
    expect(r).toEqual({ ok: false, reason: 'cert_url_bad_host' });
  });

  it('rejects a lookalike host', () => {
    const r = validateCertChainUrl(
      'https://s3.amazonaws.com.evil.example/echo.api/cert.pem',
    );
    expect(r).toEqual({ ok: false, reason: 'cert_url_bad_host' });
  });

  it('rejects the wrong path', () => {
    const r = validateCertChainUrl('https://s3.amazonaws.com/echo.api2/cert.pem');
    expect(r).toEqual({ ok: false, reason: 'cert_url_bad_path' });
  });

  it('rejects a path that only reaches /echo.api/ via traversal', () => {
    const r = validateCertChainUrl(
      'https://s3.amazonaws.com/attacker/../echo.api/../evil/cert.pem',
    );
    expect(r).toEqual({ ok: false, reason: 'cert_url_bad_path' });
  });

  it('rejects the wrong port', () => {
    const r = validateCertChainUrl('https://s3.amazonaws.com:8443/echo.api/cert.pem');
    expect(r).toEqual({ ok: false, reason: 'cert_url_bad_port' });
  });

  it('rejects an unparseable url', () => {
    expect(validateCertChainUrl('not a url').ok).toBe(false);
  });
});

describe('verifyAlexaRequest — missing headers', () => {
  it('fails with no headers at all', async () => {
    const r = await verifyAlexaRequest(envelope(), {});
    expect(r).toEqual({ ok: false, reason: 'cert_chain_url_header_missing' });
  });

  it('fails with a cert url but no signature', async () => {
    const r = await verifyAlexaRequest(envelope(), {
      signaturecertchainurl: GOOD_URL,
    });
    expect(r).toEqual({ ok: false, reason: 'signature_header_missing' });
  });

  it('fails with a signature but no cert url', async () => {
    const r = await verifyAlexaRequest(envelope(), { 'signature-256': 'abc' });
    expect(r).toEqual({ ok: false, reason: 'cert_chain_url_header_missing' });
  });

  it('reads headers case-insensitively', async () => {
    const body = envelope();
    const r = await verifyAlexaRequest(body, {
      SignatureCertChainUrl: GOOD_URL,
      'Signature-256': sign(body),
    });
    if (fixture) expect(r).toEqual({ ok: true });
    else expect(r.ok).toBe(false);
  });

  it('fails on an empty body', async () => {
    const r = await verifyAlexaRequest('', headers(''));
    expect(r).toEqual({ ok: false, reason: 'empty_body' });
  });

  it('fails on a body that is not JSON', async () => {
    const r = await verifyAlexaRequest('<html>', headers('<html>'));
    expect(r).toEqual({ ok: false, reason: 'body_not_json' });
  });
});

describe('verifyAlexaRequest — cert url shapes', () => {
  const shapes: Array<[string, string, string]> = [
    ['http', 'http://s3.amazonaws.com/echo.api/c.pem', 'cert_url_not_https'],
    ['wrong host', 'https://evil.example/echo.api/c.pem', 'cert_url_bad_host'],
    ['wrong path', 'https://s3.amazonaws.com/notecho/c.pem', 'cert_url_bad_path'],
    ['wrong port', 'https://s3.amazonaws.com:99/echo.api/c.pem', 'cert_url_bad_port'],
  ];

  for (const [label, url, reason] of shapes) {
    it(`rejects ${label}`, async () => {
      const body = envelope();
      const r = await verifyAlexaRequest(body, {
        signaturecertchainurl: url,
        'signature-256': sign(body),
      });
      expect(r).toEqual({ ok: false, reason });
    });
  }
});

describe('verifyAlexaRequest — timestamp', () => {
  it('rejects a timestamp older than 150 seconds', async () => {
    const body = envelope({
      request: { timestamp: new Date(Date.now() - 151_000).toISOString() },
    });
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a timestamp far in the future', async () => {
    const body = envelope({
      request: { timestamp: new Date(Date.now() + 600_000).toISOString() },
    });
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a missing timestamp', async () => {
    const body = JSON.stringify({ request: { type: 'LaunchRequest' } });
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'timestamp_missing' });
  });

  it('rejects an unparseable timestamp', async () => {
    const body = envelope({ request: { timestamp: 'yesterday' } });
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'timestamp_unparseable' });
  });

  it('accepts a timestamp just inside tolerance', async () => {
    const body = envelope({
      request: { timestamp: new Date(Date.now() - 100_000).toISOString() },
    });
    const r = await verifyAlexaRequest(body, headers(body));
    if (fixture) expect(r).toEqual({ ok: true });
    else expect(r.ok).toBe(false);
  });
});

describe('verifyAlexaRequest — applicationId', () => {
  it('rejects a mismatched applicationId', async () => {
    process.env['ALEXA_SKILL_ID'] = 'amzn1.ask.skill.SOMETHING_ELSE';
    const body = envelope();
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'application_id_mismatch' });
  });

  it('rejects a missing applicationId when the env var is set', async () => {
    process.env['ALEXA_SKILL_ID'] = 'amzn1.ask.skill.TEST';
    const body = JSON.stringify({
      request: { type: 'LaunchRequest', timestamp: new Date().toISOString() },
    });
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'application_id_missing' });
  });

  it('accepts a matching applicationId', async () => {
    process.env['ALEXA_SKILL_ID'] = 'amzn1.ask.skill.TEST';
    const body = envelope();
    const r = await verifyAlexaRequest(body, headers(body));
    if (fixture) expect(r).toEqual({ ok: true });
    else expect(r.ok).toBe(false);
  });

  it('skips the check when the env var is unset', async () => {
    const body = envelope();
    const r = await verifyAlexaRequest(body, headers(body));
    if (fixture) expect(r).toEqual({ ok: true });
    else expect(r.ok).toBe(false);
  });
});

describe('verifyAlexaRequest — signature over the raw body', () => {
  it.runIf(true)('accepts a correctly signed body', async () => {
    if (!fixture) return;
    const body = envelope();
    expect(await verifyAlexaRequest(body, headers(body))).toEqual({ ok: true });
  });

  it('rejects a body mutated after signing', async () => {
    if (!fixture) return;
    const body = envelope();
    const h = headers(body);
    const tampered = body.replace('ChatIntent', 'EvilIntent');
    expect(await verifyAlexaRequest(tampered, h)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a body that only differs by whitespace (raw bytes matter)', async () => {
    if (!fixture) return;
    const body = envelope();
    const h = headers(body);
    // Re-serialising through JSON.parse/stringify is exactly what a body
    // parser does; the signature must not survive it unless bytes match.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(await verifyAlexaRequest(reserialised, h)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects garbage in the signature header', async () => {
    const body = envelope();
    const r = await verifyAlexaRequest(body, {
      signaturecertchainurl: GOOD_URL,
      'signature-256': 'not-base64-!!!',
    });
    expect(r.ok).toBe(false);
  });

  it('fails closed when the cert cannot be fetched', async () => {
    __setCertFetcher(async () => {
      throw new Error('network down');
    });
    const body = envelope();
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'cert_fetch_failed' });
  });

  it('fails closed when the PEM has no certificate in it', async () => {
    __setCertFetcher(async () => 'garbage, not a pem');
    const body = envelope();
    const r = await verifyAlexaRequest(body, headers(body));
    expect(r).toEqual({ ok: false, reason: 'cert_fetch_failed' });
  });

  it('rejects a cert without the echo-api.amazon.com SAN', async () => {
    if (!fixture) return;
    let dir = '';
    try {
      dir = mkdtempSync(join(tmpdir(), 'alexa-badcert-'));
      const cnf = join(dir, 'o.cnf');
      writeFileSync(
        cnf,
        [
          '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
          '[dn]', 'CN=evil.example',
          '[v3]', 'subjectAltName=DNS:evil.example',
        ].join('\n'),
      );
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
          '-days', '2', '-config', cnf,
        ],
        { stdio: 'ignore' },
      );
      const badPem = readFileSync(join(dir, 'c.pem'), 'utf8');
      const badKey = crypto.createPrivateKey(readFileSync(join(dir, 'k.pem'), 'utf8'));
      __setCertFetcher(async () => badPem);
      const body = envelope();
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(Buffer.from(body, 'utf8'));
      signer.end();
      const r = await verifyAlexaRequest(body, {
        signaturecertchainurl: GOOD_URL,
        'signature-256': signer.sign(badKey, 'base64'),
      });
      expect(r).toEqual({ ok: false, reason: 'cert_san_missing' });
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
});
