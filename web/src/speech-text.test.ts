// Tests for the generated-text → spoken-text boundary (speech-text.ts).
//
// The anchor case is the reply the operator actually heard in the 2026-07-22
// feel-test, verbatim: a roleplay stage direction spoken as words, and a
// mid-word fragment where the 64-token cap cut the model off. Both are pure
// string problems, so the whole fix is covered here rather than in a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  completeSentencePrefix,
  createSpeechStream,
  sanitizeForSpeech,
  speakableText,
  speechChunks,
  splitSentences,
  trimToLastSentence,
} from './speech-text.ts';

// The verbatim reply from the su-lou.11 feel-test, cap-truncated tail and all.
const FEEL_TEST_REPLY =
  "*pauses, letting the thought hang in the air* You know, it's interesting that you're " +
  'thinking about the consequences and power of using Voice to better communicate what ' +
  "we're thinking while we process ideas. It's almost like you're acknowledging the " +
  'potential benefits of this approach, but not quite diving in. *pa';

test('the feel-test reply loses its stage directions and its cut-off tail', () => {
  const out = speakableText(FEEL_TEST_REPLY);
  assert.ok(!out.includes('*'), `no asterisk should survive: ${out}`);
  assert.ok(!out.includes('pauses, letting'), 'the opening stage direction is not speech');
  assert.ok(!/\bpa$/.test(out), `the truncated tail must not be spoken: ${out}`);
  assert.ok(out.startsWith('You know,'), out);
  assert.ok(out.endsWith('but not quite diving in.'), out);
});

// ── sanitizeForSpeech ──

test('asterisk-wrapped stage directions are removed, not unwrapped', () => {
  assert.equal(sanitizeForSpeech('*nods* That tension is the interesting bit.'), 'That tension is the interesting bit.');
  assert.equal(sanitizeForSpeech('Right. *leans in* Say more.'), 'Right. Say more.');
  assert.equal(sanitizeForSpeech('I think *pauses*. Yes.'), 'I think. Yes.');
});

test('an UNCLOSED stage direction — the token-cap shape — is removed too', () => {
  assert.equal(sanitizeForSpeech('That is the thread. *pa'), 'That is the thread.');
  assert.equal(sanitizeForSpeech('*pauses and thi'), '');
});

test('a reply that is nothing but a stage direction sanitizes to empty', () => {
  assert.equal(sanitizeForSpeech('*nods slowly*'), '');
  assert.equal(sanitizeForSpeech('[laughs]'), '');
});

test('bracketed and parenthesised emotes go; ordinary parentheses stay', () => {
  assert.equal(sanitizeForSpeech('[laughs] That is the tension.'), 'That is the tension.');
  assert.equal(sanitizeForSpeech('(sighs) Keep going.'), 'Keep going.');
  assert.equal(
    sanitizeForSpeech('The second one (the ranking) is the harder half.'),
    'The second one (the ranking) is the harder half.',
  );
});

test('markdown emphasis keeps its WORDS — only the markers are dropped', () => {
  assert.equal(sanitizeForSpeech('The **hook** is the streak.'), 'The hook is the streak.');
  assert.equal(sanitizeForSpeech('The __hook__ is the streak.'), 'The hook is the streak.');
  assert.equal(sanitizeForSpeech('The _hook_ is the streak.'), 'The hook is the streak.');
  assert.equal(sanitizeForSpeech('Call `decideTier` first.'), 'Call decideTier first.');
});

test('markdown furniture — headings, quotes, bullets, links, fences — is stripped', () => {
  assert.equal(sanitizeForSpeech('## The idea\n\nIt hides the number.'), 'The idea It hides the number.');
  assert.equal(sanitizeForSpeech('> It hides the number.'), 'It hides the number.');
  assert.equal(sanitizeForSpeech('- one\n- two'), 'one two');
  assert.equal(sanitizeForSpeech('* one\n* two'), 'one two');
  assert.equal(sanitizeForSpeech('See [the plan](https://example.com/x) for that.'), 'See the plan for that.');
  assert.equal(sanitizeForSpeech('Try this:\n```js\nconst a = 1;\n```\nThat is it.'), 'Try this: That is it.');
  assert.equal(sanitizeForSpeech('Try this:\n```js\nconst a = 1'), 'Try this:');
});

test('sanitizeForSpeech is idempotent (the streaming path re-runs it every partial)', () => {
  for (const s of [FEEL_TEST_REPLY, '**bold** and *emote* and [x](y)', 'plain text', '']) {
    assert.equal(sanitizeForSpeech(sanitizeForSpeech(s)), sanitizeForSpeech(s), s);
  }
});

// ── trimToLastSentence / completeSentencePrefix ──

test('a trailing fragment after a complete sentence is dropped', () => {
  assert.equal(trimToLastSentence('That is the tension. And the other half of it is'), 'That is the tension.');
  assert.equal(trimToLastSentence('Why the streak? Because the num'), 'Why the streak?');
  assert.equal(trimToLastSentence('Yes… maybe the book itself is'), 'Yes…');
});

test('a terse reply with no terminator is kept whole, not swallowed', () => {
  // Better a short unpunctuated reply than a companion that decided to speak and
  // then said nothing at all.
  assert.equal(trimToLastSentence('say more about that'), 'say more about that');
  assert.equal(completeSentencePrefix('say more about that'), '');
});

test('a decimal is not a sentence boundary', () => {
  assert.equal(trimToLastSentence('It held for 0.5 seconds before it cut'), 'It held for 0.5 seconds before it cut');
});

test('a closing quote after the terminator stays with the sentence', () => {
  assert.equal(trimToLastSentence('You said "that\'s the gist." Then you stop'), 'You said "that\'s the gist."');
});

test('trimming empty or whitespace-only text yields empty', () => {
  assert.equal(trimToLastSentence(''), '');
  assert.equal(trimToLastSentence('   \n '), '');
});

// ── chunking ──

test('splitSentences keeps each terminator with its sentence', () => {
  assert.deepEqual(splitSentences('One. Two! Three? Four'), ['One.', 'Two!', 'Three?', 'Four']);
  assert.deepEqual(splitSentences(''), []);
});

test('speechChunks merges sentences too short to synthesize on their own', () => {
  assert.deepEqual(speechChunks('Right. That is the part with the most room to grow.'), [
    'Right. That is the part with the most room to grow.',
  ]);
  assert.deepEqual(
    speechChunks('The number is the hook you are removing. So what pulls them back tomorrow?'),
    ['The number is the hook you are removing.', 'So what pulls them back tomorrow?'],
  );
  // A short tail joins the chunk before it rather than becoming a clipped clip.
  assert.deepEqual(speechChunks('That is the whole tension there. Right.'), [
    'That is the whole tension there. Right.',
  ]);
  // …but a short reply that is ALL there is still gets spoken.
  assert.deepEqual(speechChunks('Right.'), ['Right.']);
});

// ── createSpeechStream ──

test('the stream emits each sentence as soon as it completes, and never twice', () => {
  const s = createSpeechStream();
  assert.deepEqual(s.push('The number is'), []); // no boundary yet — nothing safe to say
  assert.deepEqual(s.push('The number is the hook you are removing.'), [
    'The number is the hook you are removing.',
  ]);
  assert.deepEqual(s.push('The number is the hook you are removing. So what'), []);
  assert.deepEqual(s.push('The number is the hook you are removing. So what pulls them back?'), [
    'So what pulls them back?',
  ]);
  assert.deepEqual(s.finish('The number is the hook you are removing. So what pulls them back?'), []);
  assert.equal(s.spoken, 'The number is the hook you are removing. So what pulls them back?');
});

test('the stream drops the fragment the token cap left behind', () => {
  const s = createSpeechStream();
  assert.deepEqual(s.push('That is the tension.'), ['That is the tension.']);
  assert.deepEqual(s.finish('That is the tension. And the other ha'), []);
  assert.equal(s.spoken, 'That is the tension.');
});

test('a stage direction is never spoken, mid-stream or at the end', () => {
  const s = createSpeechStream();
  // The opening emote is still unclosed here — nothing may be spoken from it.
  assert.deepEqual(s.push('*pauses, letting the thought'), []);
  assert.deepEqual(s.push('*pauses, letting the thought hang* You know, that is the tension.'), [
    'You know, that is the tension.',
  ]);
  // …and the closing one is cut mid-word by the token cap, the shape that reached
  // the operator's ears as the spoken syllable "pa".
  assert.deepEqual(s.finish('*pauses, letting the thought hang* You know, that is the tension. *pa'), []);
  assert.equal(s.spoken, 'You know, that is the tension.');
});

test('finish alone (no streaming) yields the whole cleaned reply', () => {
  const s = createSpeechStream();
  assert.deepEqual(s.finish(FEEL_TEST_REPLY), [
    "You know, it's interesting that you're thinking about the consequences and power of " +
      "using Voice to better communicate what we're thinking while we process ideas.",
    "It's almost like you're acknowledging the potential benefits of this approach, but not quite diving in.",
  ]);
  assert.equal(s.spoken, speakableText(FEEL_TEST_REPLY));
});

test('a final text that contradicts what was already said is never spoken over it', () => {
  // The shape this guards: partials stream real sentences, then the per-call
  // timeout resolves the labelled stub instead. Saying the stub after the real
  // reply would be worse than saying nothing more.
  const s = createSpeechStream();
  assert.deepEqual(s.push('That is the tension.'), ['That is the tension.']);
  assert.deepEqual(s.finish('⟨listener: reflection — LLM not loaded⟩'), []);
  assert.equal(s.spoken, 'That is the tension.');
});

test('a reply that sanitizes away entirely says nothing', () => {
  const s = createSpeechStream();
  assert.deepEqual(s.finish('*nods slowly*'), []);
  assert.equal(s.spoken, '');
});
