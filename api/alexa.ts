/**
 * Alexa endpoint: verify -> dispatch -> respond.
 *
 * Order matters and is not negotiable:
 *   1. Read the RAW body. Vercel's default JSON body parser is DISABLED below
 *      (`config.api.bodyParser = false`) because Amazon signs the exact bytes
 *      it sent. Verifying a re-serialised object silently makes every request
 *      fail — or, if someone "fixes" that by skipping the check, silently
 *      makes the endpoint open to the whole internet.
 *   2. Verify signature + timestamp + skill id. Anything short of ok -> 400
 *      with NO detail in the body (a verifier that explains itself is an
 *      oracle for whoever is probing it). The reason goes to the server log.
 *   3. Only then JSON.parse and hand the envelope to the skill.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SkillBuilders } from 'ask-sdk-core';
import type { Skill } from 'ask-sdk-core';
import type { RequestEnvelope, ResponseEnvelope } from 'ask-sdk-model';

import { verifyAlexaRequest } from '../src/alexa/verify.js';
import { createHandlers } from '../src/alexa/handlers.js';
import { runPipeline } from '../src/pipeline/index.js';
import { loadPolicy } from '../src/pipeline/policy.js';
import { getStore } from '../src/memory/db.js';

/** Vercel: do not parse the body — signature verification needs raw bytes. */
export const config = { api: { bodyParser: false } };

/** Alexa hard-fails at 8s; the pipeline's own deadline is 7s (§4.1). */
export const maxDuration = 10;

/** Largest body we will even read. Alexa envelopes are a few KB. */
const MAX_BODY_BYTES = 256 * 1024;

let cachedSkill: Skill | null = null;

function getSkill(): Skill {
  if (cachedSkill) return cachedSkill;
  const policy = loadPolicy();
  const store = getStore();
  const { requestHandlers, errorHandler } = createHandlers({
    store,
    policy,
    runPipeline,
  });
  cachedSkill = SkillBuilders.custom()
    .addRequestHandlers(...requestHandlers)
    .addErrorHandlers(errorHandler)
    .create();
  return cachedSkill;
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  // Some hosts still hand us a parsed body; fall back rather than crash, but
  // note that verification then cannot succeed (see `rawUnavailable`).
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (typeof preParsed === 'string') return preParsed;
  if (Buffer.isBuffer(preParsed)) return preParsed.toString('utf8');

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

export default async function handler(
  req: IncomingMessage & { method?: string },
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }

  const verdict = await verifyAlexaRequest(rawBody, headerMap(req));
  if (!verdict.ok) {
    // Reason to the server log only — never to the caller.
    console.warn('[alexa] request rejected:', verdict.reason);
    res.statusCode = 400;
    res.end();
    return;
  }

  let envelope: RequestEnvelope;
  try {
    envelope = JSON.parse(rawBody) as RequestEnvelope;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }

  try {
    const response: ResponseEnvelope = await getSkill().invoke(envelope);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  } catch (err) {
    // The skill's own ErrorHandler covers handler failures; this only fires if
    // dispatch itself broke. Never leak the message to the device.
    console.error('[alexa] dispatch failed:', err);
    res.statusCode = 500;
    res.end();
  }
}
