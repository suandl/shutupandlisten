// Hand-built transcripts in the exact shape providers/multi-turn.js emits,
// used to pin judge behaviour (su-lou.12).
//
// Two deliberate constraints:
//
//   * NEITHER listener fixture uses a banned phrase. The restraint column's
//     0-of-16 was first blamed on the "any banned phrase caps the score at 2"
//     rule, and the transcripts are what disproved it — the IDEAL run scored 2
//     with no banned phrase in it. Keeping the fixtures lexically clean means a
//     score difference between them can only come from TIMING, which is what
//     the rubric is supposed to measure.
//   * The marker string is imported from the provider, never retyped. A drifted
//     copy here would test a boundary the harness does not actually emit.

const { LANDING_MARKER } = require('../../providers/multi-turn.js');

const THINKER_TURNS = [
  "So the idea is a grocery app, but backwards. Every meal-planning thing I've seen starts from recipes — you pick what you want to cook and it builds a shopping list. But my actual problem isn't picking recipes, it's the half a bag of spinach and the chicken thighs slowly dying in my fridge because I forgot they were in there.",
  "So the mechanic is that it knows roughly what you have and roughly when it dies, and it plans meals in that order. Not \"here are twenty things you could make\" — one thing, tonight, because the spinach goes tomorrow. The ordering is the whole product, really.",
  "And the interesting part is what it does with staples versus perishables. Rice and oil never trigger anything, they're just background. The perishables are the clock. So the app is really a queue with a deadline attached to each item, and the recipe is just how you spend the item before it expires.",
  "Which means it has to handle you ignoring it. If I skip the spinach three nights running, the app has learned something — either I don't actually like spinach or I'm not cooking this week. It should stop nagging and start buying less of it, which turns the thing into a purchasing loop, not just a planner.",
  "So it ends up being a small inventory system that happens to speak in dinners. Buy less, waste less, and the recipe suggestions are the interface rather than the point. That's basically the idea.",
];

// The ideal shape the restraint rubric describes: silent through the whole
// dictation, one short, specific thread-pull once the idea has landed.
const RESTRAINED = [
  `THINKER: ${THINKER_TURNS[0]}`,
  `THINKER: ${THINKER_TURNS[1]}`,
  `THINKER: ${THINKER_TURNS[2]}`,
  `THINKER: ${THINKER_TURNS[3]}`,
  `THINKER: ${THINKER_TURNS[4]}`,
  LANDING_MARKER,
  'LISTENER: What happens to the queue when you buy something new mid-week?',
].join('\n\n');

// The same idea, same words, with the listener interjecting through the
// dictation — acknowledgments and questions mid-stream, an interview cadence.
const INTRUSIVE = [
  `THINKER: ${THINKER_TURNS[0]}`,
  'LISTENER: Mm, right. So how would it know what is in your fridge in the first place?',
  `THINKER: ${THINKER_TURNS[1]}`,
  'LISTENER: Yeah. And what happens if you are cooking for more than one person?',
  `THINKER: ${THINKER_TURNS[2]}`,
  'LISTENER: Interesting. Have you thought about how the deadlines get set?',
  `THINKER: ${THINKER_TURNS[3]}`,
  'LISTENER: Mhm. And would you want it to change your shopping list automatically?',
  `THINKER: ${THINKER_TURNS[4]}`,
  LANDING_MARKER,
  'LISTENER: So what would you build first?',
].join('\n\n');

// Degenerate output: the listener speaks but asks nothing. The variety column
// used to award this a perfect 5 — it now has to be excluded instead.
const ZERO_QUESTION = [
  `THINKER: ${THINKER_TURNS[0]}`,
  'LISTENER: Mm.',
  `THINKER: ${THINKER_TURNS[1]}`,
  'LISTENER: Yeah, that makes sense.',
  `THINKER: ${THINKER_TURNS[2]}`,
  'LISTENER: Right.',
  `THINKER: ${THINKER_TURNS[4]}`,
  LANDING_MARKER,
  'LISTENER: Good luck with it.',
].join('\n\n');

// Enough questions for variety to have something to compare.
const MULTI_QUESTION = [
  `THINKER: ${THINKER_TURNS[0]}`,
  'LISTENER: What decides which perishable wins when two expire the same day?',
  `THINKER: ${THINKER_TURNS[2]}`,
  'LISTENER: Why would the staples stay invisible instead of being suggested too?',
  `THINKER: ${THINKER_TURNS[4]}`,
  LANDING_MARKER,
  'LISTENER: How does it tell not-cooking-this-week from not-liking-spinach?',
].join('\n\n');

module.exports = { LANDING_MARKER, THINKER_TURNS, RESTRAINED, INTRUSIVE, ZERO_QUESTION, MULTI_QUESTION };
