import { describe, it, expect } from 'vitest';
import {
  escapeSsml,
  sanitizeForSpeech,
  trimToSentence,
  buildSpeech,
} from '../../src/alexa/ssml.ts';

describe('escapeSsml', () => {
  it('escapes all five XML entities', () => {
    expect(escapeSsml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &apos;');
  });

  it('escapes the ampersand first so entities are not double-escaped', () => {
    // If '<' were escaped before '&', the result would be '&amp;lt;'.
    expect(escapeSsml('<')).toBe('&lt;');
    expect(escapeSsml('a & b < c')).toBe('a &amp; b &lt; c');
    expect(escapeSsml('&amp;')).toBe('&amp;amp;');
    expect(escapeSsml('&<>"\'')).not.toContain('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeSsml('Saturn has rings.')).toBe('Saturn has rings.');
  });
});

describe('sanitizeForSpeech', () => {
  it('strips markdown emphasis and heading characters', () => {
    expect(sanitizeForSpeech('## A *big* _idea_ ~about~ `code`')).toBe(
      'A big idea about code',
    );
  });

  it('strips emoji', () => {
    expect(sanitizeForSpeech('Great job 🎉🐴 well done')).toBe(
      'Great job well done',
    );
  });

  it('strips flag and keycap emoji sequences', () => {
    expect(sanitizeForSpeech('hi 🇺🇸 there')).toBe('hi there');
  });

  it('strips bare URLs', () => {
    expect(sanitizeForSpeech('Look at https://example.com/x?y=1 now')).toBe(
      'Look at now',
    );
    expect(sanitizeForSpeech('Try www.example.com today')).toBe('Try today');
  });

  it('reduces bracketed link syntax to its text', () => {
    expect(sanitizeForSpeech('See [the moon](https://example.com) tonight')).toBe(
      'See the moon tonight',
    );
  });

  it('strips code fences', () => {
    expect(sanitizeForSpeech('Before ```let x = 1;``` after')).toBe(
      'Before after',
    );
  });

  it('collapses whitespace', () => {
    expect(sanitizeForSpeech('a\n\n  b\t\tc  ')).toBe('a b c');
  });

  it('preserves ordinary apostrophes', () => {
    expect(sanitizeForSpeech("Don't worry, it's the dog's bone.")).toBe(
      "Don't worry, it's the dog's bone.",
    );
  });

  it('preserves hyphens inside words', () => {
    expect(sanitizeForSpeech('A well-known twenty-one year-old idea.')).toBe(
      'A well-known twenty-one year-old idea.',
    );
  });

  it('does not swallow angle brackets (escaping handles those)', () => {
    expect(sanitizeForSpeech('2 < 3')).toBe('2 < 3');
  });
});

describe('trimToSentence', () => {
  it('returns the whole text when it fits', () => {
    const r = trimToSentence('Short one.', 600);
    expect(r.spoken).toBe('Short one.');
    expect(r.remainder).toBe('');
  });

  it('returns the whole text at exactly the cap', () => {
    const text = 'abcdefghij'; // 10 chars
    const r = trimToSentence(text, 10);
    expect(r.spoken).toBe(text);
    expect(r.remainder).toBe('');
  });

  it('cuts at the last sentence boundary under the cap', () => {
    const text = 'One two. Three four. Five six seven eight nine ten.';
    const r = trimToSentence(text, 25);
    expect(r.spoken).toBe('One two. Three four.');
    expect(r.remainder).toBe('Five six seven eight nine ten.');
    expect(r.spoken.length).toBeLessThanOrEqual(25);
  });

  it('handles ! and ? as sentence boundaries', () => {
    const text = 'Wow! Do you know why? Because the sun is very far away indeed.';
    const r = trimToSentence(text, 25);
    expect(r.spoken).toBe('Wow! Do you know why?');
    expect(r.remainder).toBe('Because the sun is very far away indeed.');
  });

  it('handles a sentence boundary landing exactly on the cap', () => {
    const text = 'One two three four. Five six.';
    // 'One two three four.' is exactly 19 characters.
    const r = trimToSentence(text, 19);
    expect(r.spoken).toBe('One two three four.');
    expect(r.remainder).toBe('Five six.');
  });

  it('does not treat a decimal point as a sentence boundary', () => {
    const text = 'Pi is about 3.14159265 which is a number you can keep going with.';
    const r = trimToSentence(text, 20);
    expect(r.spoken).not.toContain('3.14159265 ');
    expect(r.spoken.endsWith('.')).toBe(false);
  });

  it('falls back to a word boundary when no sentence boundary fits', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel';
    const r = trimToSentence(text, 20);
    expect(r.spoken).toBe('alpha bravo charlie');
    expect(r.remainder).toBe('delta echo foxtrot golf hotel');
    expect(r.spoken.length).toBeLessThanOrEqual(20);
  });

  it('never splits a word', () => {
    const text = 'antidisestablishmentarianism is a very long word to say aloud';
    const r = trimToSentence(text, 10);
    expect(r.spoken).toBe('antidisestablishmentarianism');
    expect(r.remainder).toBe('is a very long word to say aloud');
  });

  it('returns the whole text when there is no boundary at all', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const r = trimToSentence(text, 5);
    expect(r.spoken).toBe(text);
    expect(r.remainder).toBe('');
  });

  it('recombines to the original words', () => {
    const text = 'One two. Three four. Five six seven.';
    const r = trimToSentence(text, 25);
    expect(`${r.spoken} ${r.remainder}`.trim()).toBe(text);
  });
});

describe('buildSpeech', () => {
  it('sanitizes then escapes then wraps', () => {
    expect(buildSpeech('**Bees** & wasps 🐝 are < insects')).toBe(
      '<speak>Bees &amp; wasps are &lt; insects</speak>',
    );
  });

  it('accepts a pipeline-result shape', () => {
    expect(buildSpeech({ speech: "It's fine." })).toBe(
      '<speak>It&apos;s fine.</speak>',
    );
  });

  it('never emits a raw markdown or URL fragment', () => {
    const out = buildSpeech('See *this*: https://evil.example/x `code`');
    expect(out).not.toContain('http');
    expect(out).not.toContain('*');
    expect(out).not.toContain('`');
  });
});
