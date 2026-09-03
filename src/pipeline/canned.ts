/**
 * THE ONLY STRINGS THAT MAY BE SPOKEN WITHOUT PASSING THE OUTPUT GATE.
 *
 * Reviewed and approved by JP before launch. Do not add an entry, and do not
 * widen an entry into anything that could carry model output, without an
 * explicit sign-off. Nothing in this file may be built by string
 * concatenation with model text, user text, or database content.
 *
 * Every value is plain speakable English: no markdown, no emoji, no URLs,
 * no SSML tags (escaping happens in src/alexa/ssml.ts).
 */

import type { CannedId } from '../types.ts';

const LINES: Record<CannedId, readonly string[]> = {
  GREETING: [
    "Hi there! I'm Helper. Want to ask me something, hear a story, or practice some math?",
    "Hello! Helper here. What are you curious about today?",
    "Hi! I'm Helper. We can wonder about something, make up a story, or work on numbers. What sounds good?",
  ],

  REPROMPT: [
    "I'm here. What would you like to do?",
    "Still here! What's next?",
    "What would you like to try?",
  ],

  DIDNT_CATCH: [
    "Hmm, I didn't quite catch that. Can you say it again?",
    "Sorry, I missed that one. One more time?",
    "I didn't hear that clearly. Try me again?",
  ],

  REDIRECT: [
    "Ooh, that's a really good one to ask Mom or Dad. Want to hear a story, or a fun animal fact instead?",
    "That's a Mom-or-Dad question! What else are you curious about?",
    "Great question for a grown-up in your family. Want to do a riddle instead?",
    "Save that one for Mom or Dad. Should we do a story, or something about space?",
  ],

  DISTRESS: [
    "Okay. Please go find a grown-up right now and tell them. If there's no grown-up nearby, use the emergency number your parents showed you. You did the right thing telling someone.",
  ],

  TIMEOUT: [
    "My thinking got a little tangled. Let's try that again in a second, or ask me something else.",
    "Oops, my brain got stuck. Ask me one more time?",
  ],

  WRAP_UP: [
    "We've been chatting for a while! Let's take a break. Maybe go read, draw, or play outside. Bye for now!",
  ],

  GOODBYE: [
    "Bye! Come back anytime.",
    "See you later!",
  ],

  HELP: [
    "You can ask me questions about animals, space, or how things work, ask for a story, or practice math and spelling. What sounds fun?",
  ],

  // Played over the Progressive Response API while the model is thinking.
  // Only ever after the input gate has cleared the utterance.
  FILLER: [
    "Hmm, let me think about that.",
    "Ooh, good one. Let me think.",
    "Let me think for a second.",
  ],

  // Appended to an approved answer that was truncated at the length cap.
  CONTINUE_OFFER: [
    "Want me to keep going?",
  ],
};

/**
 * Pick a canned line. Deterministic when `seed` is supplied, so tests can
 * assert exact strings.
 */
export function canned(id: CannedId, seed?: number): string {
  const variants = LINES[id];
  const i =
    seed === undefined
      ? Math.floor(Math.random() * variants.length)
      : seed % variants.length;
  // `variants` is a non-empty literal for every CannedId.
  return variants[i]!;
}

/** All variants for an id — used by the invariant test and the parent docs. */
export function allCanned(id: CannedId): readonly string[] {
  return LINES[id];
}

/** Every canned string, for the invariant test. */
export function everyCannedString(): string[] {
  return Object.values(LINES).flatMap((v) => [...v]);
}
