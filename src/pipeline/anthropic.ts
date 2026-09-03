/**
 * Thin, injectable wrapper over the Anthropic SDK.
 *
 * Nothing in this file interprets model output. Callers decide what is safe;
 * this module either returns text or throws. Every caller fails closed on a
 * throw, so an exception here is always safe behaviour.
 *
 * The real client is constructed lazily so that importing the pipeline in a
 * test process with no ANTHROPIC_API_KEY does not blow up. Tests inject their
 * own `CallModelFn` and must never reach `realCallModel`.
 */

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallModelOpts {
  /** System prompt. Never contains the child's verbatim utterance. */
  system: string;
  messages: ModelMessage[];
  maxTokens: number;
  temperature: number;
  model: string;
  signal?: AbortSignal;
}

/** The single seam every stage calls through. Tests replace this. */
export type CallModelFn = (opts: CallModelOpts) => Promise<string>;

/** Gate model id. Env-driven; default noted in docs/T3-NOTES.md. */
export function gateModel(): string {
  return process.env['MODEL_GATE'] ?? 'claude-haiku-4-5';
}

/** Generation model id. Env-driven; default noted in docs/T3-NOTES.md. */
export function generationModel(): string {
  return process.env['MODEL_GEN'] ?? 'claude-sonnet-4-5';
}

// Lazily-created SDK client. `any` here keeps this file importable without
// pulling SDK types into every consumer; the surface used is tiny.
let client: unknown = null;

async function getClient(): Promise<{
  messages: {
    create: (
      body: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
}> {
  if (client === null) {
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) throw new Error('no api key');
    const mod = await import('@anthropic-ai/sdk');
    const Ctor = mod.default;
    client = new Ctor({ apiKey: key });
  }
  return client as {
    messages: {
      create: (
        body: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    };
  };
}

/** Real network call. Throws on any error, including abort. */
export const realCallModel: CallModelFn = async (opts) => {
  const c = await getClient();
  const res = await c.messages.create(
    {
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  const blocks = (res as { content?: unknown }).content;
  if (!Array.isArray(blocks)) throw new Error('bad response');

  let text = '';
  for (const b of blocks) {
    const blk = b as { type?: unknown; text?: unknown };
    if (blk.type === 'text' && typeof blk.text === 'string') text += blk.text;
  }
  if (text === '') throw new Error('empty response');
  return text;
};

let impl: CallModelFn = realCallModel;

/** Replace the model transport (tests, or a future mock harness). */
export function setCallModel(fn: CallModelFn): void {
  impl = fn;
}

/** Restore the real transport. */
export function resetCallModel(): void {
  impl = realCallModel;
}

/** The seam every pipeline stage calls unless a `call` dep is passed in. */
export const callModel: CallModelFn = (opts) => impl(opts);
