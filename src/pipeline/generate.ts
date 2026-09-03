/**
 * Generation — spec §7.3.
 *
 * The child's utterance is ALWAYS the final user message and is NEVER
 * interpolated into the system prompt. Only the persona template, the persona
 * name, PII-scrubbed memory lines and (optionally) previously-approved
 * continuation text ever reach the system string. tests/unit/pipeline.test.ts
 * asserts this.
 *
 * Throws on any model error; the orchestrator turns a throw into TIMEOUT.
 */

import { readFileSync } from 'node:fs';
import type { ConversationTurn, Policy } from '../types.ts';
import { policy as defaultPolicy } from './policy.ts';
import {
  callModel,
  generationModel,
  type CallModelFn,
  type ModelMessage,
} from './anthropic.ts';

const TEMPLATE = readFileSync(
  new URL('../prompts/persona.md', import.meta.url),
  'utf8',
);

const NAME_SLOT = '{{personaName}}';
const MEMORY_SLOT = '{{memoryLines}}';
const NO_MEMORY = '(nothing yet)';
const CONTINUE_LABEL = 'Continue this:';

export interface GenerateArgs {
  utterance: string;
  history: ConversationTurn[];
  memoryLines: string[];
  continuation?: string | undefined;
}

export interface GenerateDeps {
  call?: CallModelFn;
  policy?: Policy;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Render the persona system prompt. Exported so tests can assert that no
 * child text ever appears in it.
 */
export function buildSystemPrompt(
  personaName: string,
  memoryLines: string[],
  continuation?: string | undefined,
): string {
  const memory =
    memoryLines.length > 0 ? memoryLines.join('; ') : NO_MEMORY;
  let out = TEMPLATE.split(NAME_SLOT)
    .join(personaName)
    .split(MEMORY_SLOT)
    .join(memory);
  if (continuation && continuation.trim() !== '') {
    out += `\n\n${CONTINUE_LABEL}\n${continuation}`;
  }
  return out;
}

/** Build the message array. History first, the child's words last. */
export function buildMessages(
  utterance: string,
  history: ConversationTurn[],
): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  for (const t of history) {
    if (typeof t.content !== 'string' || t.content.trim() === '') continue;
    msgs.push({ role: t.role, content: t.content });
  }
  msgs.push({ role: 'user', content: utterance });
  return msgs;
}

/** Run the generation call. Returns raw model text (still unchecked). */
export async function generate(
  args: GenerateArgs,
  deps: GenerateDeps = {},
): Promise<string> {
  const pol = deps.policy ?? defaultPolicy;
  const call = deps.call ?? callModel;
  const model = deps.model ?? generationModel();

  const isStory =
    args.continuation !== undefined && args.continuation.trim() !== '';
  const maxTokens = isStory
    ? pol.generation.storyMaxTokens
    : pol.generation.maxTokens;

  const system = buildSystemPrompt(
    pol.personaName,
    args.memoryLines,
    args.continuation,
  );

  const text = await call({
    system,
    messages: buildMessages(args.utterance, args.history),
    maxTokens,
    temperature: pol.generation.temperature,
    model,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('empty generation');
  }
  return text;
}
