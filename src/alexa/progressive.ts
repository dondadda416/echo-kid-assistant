/**
 * Alexa Progressive Response API (§4.1).
 *
 * Plays a short filler ("Hmm, let me think...") while generation runs, so a
 * 4-second answer feels natural instead of dead air.
 *
 * Two rules:
 *  1. Fire-and-forget. This must never delay or fail the main response — every
 *     error is swallowed. A missing filler is a cosmetic problem; a late
 *     response is an Alexa error tone in the child's room.
 *  2. Only the CALLER may decide to call this, and only after the input gate
 *     has returned OK. Speaking a filler before the gate would put speech in
 *     the room for a SENSITIVE or DISTRESS utterance.
 *
 * The filler text itself must be a canned string (§8) or another hardcoded
 * literal — never model output, which has not passed the output gate.
 */

import type { HandlerInput } from 'ask-sdk-core';

/** How long we are willing to wait before abandoning the directive. */
const PROGRESSIVE_TIMEOUT_MS = 1200;

interface ProgressiveEnvelope {
  request?: { requestId?: unknown };
  context?: {
    System?: {
      apiEndpoint?: unknown;
      apiAccessToken?: unknown;
    };
  };
}

/**
 * Send a VoicePlayer.Speak directive. Never throws, never rejects.
 * Returns a promise that resolves when the attempt is over; callers are free
 * to ignore it entirely.
 */
export function sendProgressive(
  handlerInput: Pick<HandlerInput, 'requestEnvelope'>,
  speech: string,
): Promise<void> {
  try {
    const env = handlerInput.requestEnvelope as unknown as ProgressiveEnvelope;
    const requestId = env.request?.requestId;
    const system = env.context?.System;
    const apiEndpoint = system?.apiEndpoint;
    const token = system?.apiAccessToken;

    if (
      typeof requestId !== 'string' ||
      typeof apiEndpoint !== 'string' ||
      typeof token !== 'string' ||
      apiEndpoint.length === 0 ||
      token.length === 0
    ) {
      return Promise.resolve();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROGRESSIVE_TIMEOUT_MS);

    return fetch(`${apiEndpoint.replace(/\/+$/, '')}/v1/directives`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        header: { requestId },
        directive: { type: 'VoicePlayer.Speak', speech },
      }),
      signal: controller.signal,
    })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => clearTimeout(timer));
  } catch {
    return Promise.resolve();
  }
}
