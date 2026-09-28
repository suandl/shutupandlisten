# Positioning and discovery — how would anyone find this?

Status: research synthesis, 2026-09-28. Not ratified. Five parallel research
passes (audience, landscape, discovery channels, activation, red team) against
the premise recorded in `CONCEPTS.md`:

> Agents talk too much. Voice recorders don't talk at all. This one listens.

## What changed the picture

Two facts from this month reshape the plan. Both were checked against
multiple independent sources.

- **ChatGPT has half-shipped "quiet mode."** GPT-Live (launched 2026-07-08) is
  full-duplex: it waits through mid-sentence pauses, backchannels "mhmm", and
  can be told to stay silent until addressed ("Hey Chat")
  ([OpenAI](https://openai.com/index/introducing-gpt-live/),
  [Ubergizmo](https://www.ubergizmo.com/2026/07/finally-chatgpt-voice-will-stop-interrupting-you-mid-sentence/),
  [Technology.org](https://www.technology.org/2026/07/09/openai-gpt-live-full-duplex-voice-models/)).
  It is an instruction you repeat per session, not a default, and complaints
  continue after launch
  ([forum](https://community.openai.com/t/chatgpt-live-voice-still-interupts-too-much-what-happened-to-hold-to-talk/1386172)),
  but **silence alone is no longer a moat.**
- **Custom GPTs are being retired** (announced 2026-09-11, retired
  2026-12-11; personal plans already cannot create new ones) in favour of
  plugins/skills
  ([OpenAI FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq),
  [mixed-news](https://mixed-news.com/en/openai-retiring-custom-gpts-what-carries-over-to-plugins/)).
  The GPT Store is not a channel for the free prompt.

## Positioning: keep the premise, move the weight

All five passes converged on the same adjustment.

- **The premise is the setup, not the claim.** It places the product in half
  a second against two things everyone knows. But "it listens / stays quiet"
  is now the easiest part to copy, and it names no outcome.
- **The claim is the question.** What no incumbent optimizes for — and what
  this repo already measures (B3/B5 in `docs/usefulness-bar.md`; the
  no-summarize, probing-depth and variety judges) — is *never summarizing
  back* and *one question that engages what you specifically said.* Working
  line: *"It stays quiet, then asks the one question you hadn't thought of."*
- **Say "ChatGPT voice", not "agents", to consumers.** "Agents" is insider
  vocabulary; the pain people post is "it keeps cutting me off."
- **Don't over-promise silence.** `docs/on-device-quiet-companion-recommendation.md`
  records that no measured on-device config clears B1 yet. A headline built on
  "this one listens" turns a single interruption into the complaint.
- **The name** works as brand, domain, meme and caption layer; it is weaker as
  a consumer App Store title (it reads as aimed at *you*, and is awkward to
  recommend aloud). Worth testing a subtitle form, e.g. *"shutupandlisten — a
  quiet thinking partner."*

Alternative frames the red team generated, for testing rather than adoption:

| Frame | Line | Pulls in | Weakness |
|---|---|---|---|
| Identity | "For people who think by talking." | verbal processors, ADHD | niche size unknown |
| Outcome | "Walk in with a mess. Walk out knowing what you think." | founders, deciders | pulls toward summarizing |
| Method | "One good question beats ten answers." | coaches' clients, journalers | abstract until demoed |
| Moment | "Your walk, with a better question." | walkers, commuters | Nomad AI is near it |
| Craft | "Talk your first draft. It asks what your editor would." | writers | AudioPen's home turf |

## Who: the beachhead

**Walkers and drivers who already think out loud with ChatGPT voice** —
founders, PMs, strategists, indie creators. Why:

1. The job is proven and daily; the complaint is specific. People are
   hand-writing "only say mhm until I say your name" instructions
   ([example](https://mirajadesign.com/how-to-solve-chatgpts-interruptions-in-voice-conversations/))
   — this product in its crudest form.
2. The usefulness bar was derived from exactly this use, so the product is
   tuned for this person.
3. They already pay for AI and are reachable (X, Substack, Indie Hackers, HN).
4. The premise lands word for word for them.

Secondary segments, in order: **ADHD / verbal processors** (large, loud pain —
"with ADHD, this distracts me so much that I lose my thought" — but crowded,
churny, and adjacent to mental-health claims to avoid); **writers who dictate
on walks** (reachable via author podcasts; many want transcription more than
questions); **non-native and slow speakers** (the loudest interruption pain,
but their job is language practice — an audience for the endpointing work, not
the pitch); **engineers rubber-ducking** (instantly get it, but they debug at a
desk, in text).

## Where: the landscape and the gap

- **Talking side** (ChatGPT/GPT-Live, Gemini Live, Claude voice, Pi, Sesame) is
  racing toward human-like, emotional, full-duplex conversation.
- **Silent side** (Voice Memos, AudioPen, Voicenotes, Cleft, Letterly, Oasis,
  Superwhisper, Wispr Flow) assumes value is the *output* — transcripts,
  summaries, rewrites.
- **Adjacent** journaling apps (Rosebud, Mindsera, Stoic) reflect and coach —
  exactly what this product refuses.
- **Nobody claims "listens more than it talks"** as the product. Cleft ("for
  verbal thinkers") is the closest audience match but is a recorder.

Defensible angle: restraint is the *whole* product and it is *measured*. The
big assistants are one-assistant-for-everything and will not tune a mode
against a no-summarize judge. On-device speech and a walk ritual reinforce it.

## How they find it: ranked channels

1. **Answer the complaint threads** (SEO + community replies). One page, "How
   to make ChatGPT/Claude voice stop interrupting and summarizing," with the
   free prompt, a copy button and a 20-second audio demo; link from existing
   OpenAI-forum / Gemini-support threads
   ([example](https://community.openai.com/t/feature-request-advanced-voice-mode-keeps-interrupting-me/962909)).
   **Best use of the free prompt** — it meets people at the moment of pain and
   hands off to the app. Package the prompt as a ChatGPT skill/plugin and a
   Claude Project, not a GPT.
2. **Short video of silence** (TikTok/Reels/Shorts). Every AI voice demo shows
   the AI talking; this one is 15 seconds of nothing, then one sharp question.
   A/B side-by-side-with-ChatGPT vs. silence alone; watch saves and shares.
3. **Show HN: "A voice AI graded on how little it says."** Links the web build
   and the promptfoo judges. Superwhisper, Oasis and Cleft all launched here.
4. **Build in public → Product Hunt** (AudioPen's path: hackathon build, X,
   #1 on PH, $73K in two months). Optionally a Voicenotes-style limited
   "founding listener" lifetime offer to fund API costs.
5. **App Store search.** The "think out loud / thinking partner / brain dump /
   voice journal" keywords are populated (Ventee, Voticle, ThinkAloud), which
   proves search demand; differentiate on "doesn't summarize." Test subtitle
   "Think out loud. It stays quiet." with two custom product pages (founders
   vs. ADHD).
6. **ADHD / brain-dump communities** — non-promotional posts linking only the
   free prompt; creator collaborations.
7. **Transcript export to Obsidian / Notion / Apple Notes** — the byproduct
   becomes the discovery surface in PKM communities.
8. **Shareable session card** ("14 minutes, 2 questions") — makes restraint
   visible and a little funny.
9. **Newsletters/podcasts** on thinking, writing, founder productivity (Wispr
   grew via founder podcasts); **coaches and writing teachers** later.

The name is the caption layer across 2 and 8 ("I told my AI to shut up and
listen"), not a channel of its own.

## The hurdle after they find it: activation

A product whose value is silence has a brutal first run: talk, hear nothing,
conclude it's broken. Findings grounded in the current iOS build:

1. **The proof beat can't happen early, and hits a wall when it does.** The
   gate won't ask until the *second* substantive (12+ word) thought, and
   sign-in is requested *at the moment of the question* (an error alert in
   builds without Sign in with Apple). Many first sessions end having only met
   the "doesn't talk" half — which looks like a Voice Memos clone.
   *Fix:* sign-in (or an anonymous allowance) before the first session;
   let the first substantive thought earn the question in session 1; surface
   "Pull a thread" after ~60s. **Activation metric: heard one specific
   question within 3 minutes of first session.**
2. **Silence reads as broken.** Acknowledgments are off by default and the
   "waiting on purpose" tip shows only once it is already waiting. *Fix:* live
   words-on-screen in session 1; show the tip before the first pause; one soft
   early "mm" so the user knows it *can* talk and is choosing not to.
3. **Blank page.** After onboarding the screen says only "ready." *Fix:* three
   starter chips at the end of onboarding ("A decision you're stuck on",
   "Something you keep circling", "A hard conversation coming up") mapped to
   existing presets; a rotating starter under "ready."
4. **Talking to your phone is awkward.** *Fix:* frame for private moments
   (walk with AirPods, car, before bed); put the on-device privacy line next
   to the start button.
5. **No reason to come back** (and push notifications are out by design).
   *Fix:* always end with a thread to pull ("leave me with a question" at
   stop); show it as "Start here next time" on the idle screen; one post-session
   "When will you think out loud next?" step offering the Siri/Action-button
   shortcut.

Onboarding should make each half of the premise *felt*: the first minute
visibly holds back (agents talk too much); there is always a question by the
end (recorders don't talk at all); the question quotes the user's own words
(this one listens).

## Suggested first moves

1. Fix activation risk 1 in the iOS app — without it, every channel below
   leaks at the first session.
2. Ship the "stop ChatGPT voice interrupting you" page with the free prompt +
   audio demo, and seed it in the complaint threads.
3. Record five 20-second silence-then-question clips; post in one week.
4. Prepare the Show HN post around the restraint judges.

## Open questions

- Is the beachhead founder-walkers or verbal processors? Test with the two
  App Store custom product pages and the two video openings.
- Consumer name: keep "shutupandlisten" as the App Store title, or use it as
  brand with a softer title?
- Does the free prompt funnel to the app or substitute for it? The app needs
  something the prompt can't reproduce: gate-enforced silence, on-device
  privacy, session history, the end-of-session thread.

Source confidence: pricing for AudioPen/Superwhisper and some growth figures
(Voicenotes) come from secondary sources; direct Reddit evidence was thin;
the ChatGPT "stay silent" behaviour is confirmed by press and how-to guides.
