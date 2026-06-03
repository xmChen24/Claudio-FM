# DJ Personalization Goals

This document turns the "real private DJ" direction into implementable goals.

## Goal 1: Intent-Aware Request Line

Status: implemented baseline.

Claudio should not treat every listener message as a music request. The request line should classify inputs into product intents before the LLM writes anything.

Implemented intent types:

- `exact_track_request`: a specific song, usually with artist context.
- `artist_request`: play songs by a specific artist.
- `direct_music_request`: a bare song/artist query such as `HUMBLE` or `Drake`.
- `vibe_request`: a broader music direction such as `More like this` or `来点适合工作的歌`.
- `positive_feedback`: the listener likes the current track.
- `negative_feedback`: the listener dislikes the current track.
- `correction`: the listener says the station misunderstood the request.
- `session_context`: the listener describes current state, mood, or activity.
- `host_style_feedback`: the listener asks Claudio to speak less or more.
- `conversation`: ordinary chat that should get a direct answer without changing music.

Acceptance checks:

- `Drake`, `HUMBLE`, and `play HUMBLE by Kendrick Lamar` enter the music path.
- `More like this` and `来点适合工作的歌` enter the music path as vibe requests.
- `这首歌不错`, `这首歌不好听`, `我在工作`, and `少说点` update tone or memory without enqueueing music.
- `不是这种 Drake` is classified as a correction and only enqueues a correction-recovery program when there is enough current or recent music context to recover from.

## Goal 2: Deterministic DJ Memory

Status: implemented baseline.

Claudio should remember only explicit listener signals. The LLM must not invent long-term preference updates.

Implemented memory:

- Runtime file: `user/dj-memory.json`.
- Ignored by Git because it contains private listening data.
- Positive feedback can record liked current tracks/artists.
- Negative feedback can record disliked current tracks and avoided artists.
- Host style feedback can record `quiet` or `hosty`.
- Session signals can record current mood/activity for a short-lived prompt window.

Current safeguards:

- Memory updates are rule-based and explainable.
- Session mood/activity expires from prompt relevance after six hours.
- Lists are capped to avoid prompt bloat.

## Goal 3: Personalized Prompt Context

Status: implemented baseline.

Every DJ planning prompt should see both static taste files and dynamic DJ memory.

Implemented prompt sections:

- Static taste: `user/taste.md`.
- Routines: `user/routines.md`.
- Mood rules: `user/mood-rules.md`.
- Dynamic DJ memory: runtime preferences and session state.
- Recent play history.
- Recent on-air / call-in history.
- Explicit user intent details.

Acceptance checks:

- Speech-only prompts must answer directly and return an empty `play` array.
- Feedback/correction/session-context prompts must not pretend a new song was requested.
- Program start prompts use dynamic memory as taste/tone guidance without mentioning the memory system.

## Goal 4: Program Arc

Status: implemented baseline.

Claudio should manage a short radio arc instead of picking unrelated songs.

Implemented shape:

- Track energy for the current set: opening, settling, lift, landing.
- Infer the arc target from the listener request: focus, soft landing, energy lift, late night, request lane, correction recovery, or open format.
- Store the active arc in station state.
- Pass the arc into program start, cold open, refill, and bridge prompts.
- Include the arc in program-start and refill payloads.
- Expose the active arc through `GET /api/program-arc`.

Acceptance checks:

- Refills avoid sudden energy jumps unless requested.
- Bridges can reference the actual transition between confirmed tracks.
- The station can intentionally choose silence when the transition is self-explanatory.
- `来点适合工作的歌` creates a focus-oriented arc.
- Direct requests such as `Drake` create a request-lane arc.

## Goal 5: Correction Loop

Status: implemented baseline.

When the listener says "not this" or "不是这种", Claudio should recover instead of guessing blindly.

Implemented shape:

- Keep the last music intent in station state.
- Build a correction context from the listener message, current track, recent tracks, and last music intent.
- Queue a correction recovery `program_start` when there is enough context to recover.
- Pass correction constraints into track planning and cold-open generation.
- Create a correction-recovery program arc so the next set is not a random restart.

Acceptance checks:

- "不是这种 Drake" stays near the Drake clue but asks for a different era, energy, or style than the rejected result.
- "不是这个版本" searches for alternate versions/remixes/live edits.
- "不是这首" does not add the current track back to the queue.

## Goal 6: Listener Controls For Taste

Status: partially implemented.

The UI should make personalization lightweight without forcing the listener to type.

Implemented controls:

- More like this.
- Change vibe.
- Quiet / Story / Companion host mode.

Candidate controls:

- Less like this.
- Do not play this artist.
- Save this vibe.
- Why this track?

Acceptance checks:

- Each control maps to a clear backend intent.
- Feedback updates memory immediately.
- Controls do not interrupt playback unless their intent requires it.

## Goal 7: Memory Review And Editing

Status: planned.

Private memory should be visible and correctable.

Implementation shape:

- Add a small settings panel backed by `GET /api/dj-memory`.
- Allow deleting mistaken liked/disliked artists or tracks.
- Allow resetting session context without deleting long-term taste.

Acceptance checks:

- The listener can inspect what Claudio believes.
- The listener can remove incorrect memory without editing JSON manually.
- Private memory remains local.

## Goal 8: Faster Hosted Playback

Status: implemented baseline.

Claudio should let the DJ speak first when a short lead-in can be generated
quickly, without letting slow long-form writing, TTS synthesis, or bridge
generation block the station.

Implemented shape:

- Program start resolves the first playable track first.
- A short `openingLeadIn` is generated and synthesized with soft timeouts; when
  it is ready, the browser plays it before the first song.
- Remaining startup tracks are resolved by `music_tail_resolve` and appended
  through `tracks-ready`.
- Full cold-open writing and opening TTS run in `opening_generation` after the
  first-song path is already moving.
- Bridge writing and bridge TTS run in `bridge_generation` background jobs.
- Music refill runs as a foreground job and appends tracks through
  `tracks-ready`.
- The front end serializes request-line voice and DJ segments so late openings
  or bridges do not interrupt each other.
- A new `program-start` with a different `programId` resets old frontend program
  state, while `tracks-ready` keeps appending to the current program.

Acceptance checks:

- First playable track resolution does not wait for the whole startup set.
- DJ lead-in plays before music when lead-in LLM and TTS finish inside the
  configured timeout.
- If lead-in generation or TTS is too slow, startup falls back to fast music
  start instead of leaving the station silent.
- Auto-refill does not release its in-flight flag until `tracks-ready`, failure,
  or a rejected duplicate refill response.
- Correction recovery and vibe changes do not mix stale queue or segment state
  from the previous program.
- `SPOTIFY_FAST_START=1` can skip yt-dlp stream fallback for Spotify URI playback
  when Web Playback is connected.

Operational details live in `docs/RADIO_ENGINE.md`.
