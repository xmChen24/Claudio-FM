# Radio Engine Notes

This document describes the current Claudio FM radio runtime: how a listener
request becomes music, where DJ speech is generated, and which knobs affect
latency and reliability.

## Runtime Shape

Claudio is a single-listener local radio station. The browser owns playback and
the Node server owns planning, music resolution, TTS, memory, and job queues.

Core modules:

- `router.js` classifies listener input before any LLM call.
- `server.js` runs HTTP routes, WebSocket broadcasts, job queues, music
  resolution, and TTS orchestration.
- `context.js` builds DJ prompts from static taste, dynamic memory, environment,
  recent history, active program arc, and correction context.
- `dj-memory.js` stores explicit listener feedback in `user/dj-memory.json`.
- `program-arc.js` tracks the current set direction and energy curve.
- `dj-correction.js` turns listener corrections into negative constraints.
- `pwa/index.html` owns playback, voice sequencing, request line behavior,
  refill triggers, and UI state.

## Request Flow

`POST /api/chat` is the main listener input route.

1. `router.js` classifies the message.
2. Control intents broadcast immediately: next, pause, resume, volume.
3. Explicit listener feedback updates `user/dj-memory.json` without asking the
   LLM to invent preferences.
4. Music intents enqueue a foreground `program_start` job.
5. Corrections with enough context enqueue a correction-recovery `program_start`
   job.
6. Speech-only conversation goes through `runRadioSegment` and returns an
   immediate spoken response without adding music.

Program start jobs now prioritize the first playable track. Once the first track
is confirmed, Claudio generates and synthesizes a short `openingLeadIn` with a
soft timeout. If that lead-in is ready in time, the browser plays it before the
first song. If it is not ready in time, the browser keeps the fast-start behavior
and begins music without waiting for the full opening.

The remaining startup tracks are resolved by `music_tail_resolve` and appended
with `tracks-ready`. The full opening DJ script and bridge scripts are generated
in background jobs after the first song path is already moving.

## Job Queues

There are two queues:

- Foreground queue: `program_start`, `music_tail_resolve`, `music_refill`.
- Background queue: `opening_generation`, `bridge_generation`.

Foreground jobs protect the music supply. Background jobs improve hosting
without blocking first playback.

Important WebSocket events:

- `job-status`: phase and failure updates for UI status text.
- `program-start`: new program, first confirmed tracks, program arc, optional
  lead-in segment, and `openingPending` while the long opening is still being
  written.
- `tracks-ready`: tail-resolved or refill tracks appended to the existing
  program.
- `segment-ready`: DJ opening continuation or bridge segments ready for
  playback.
- `system-log`: user-facing fallback or voice-engine notices.

## Frontend Playback State

The browser treats `program-start` as a new show when the incoming `programId`
differs from the current one. In that case it clears old queue state, pending DJ
segments, TTS playback, Spotify state, and refill flags before loading the new
program. This protects correction recovery and vibe changes from mixing old and
new shows.

`tracks-ready` is different: it appends refill tracks to the current program and
does not reset playback.

DJ voice is serialized through a voice channel:

- When `program-start` includes `openingLeadIn`, the browser queues the tracks
  but waits for that first DJ sentence to finish before starting the first song.
- Request-line caller voice blocks immediate DJ interruptions until it finishes.
- Immediate segments are queued and de-duplicated by segment key.
- Opening continuation segments are only played near the start of the first
  track; if they arrive after the continuation window, they are dropped rather
  than interrupting the body of the song.
- Bridge segments are delivered at song seams when possible.
- The front end avoids replaying handled segments when late background jobs
  arrive.

## Latency And Reliability Knobs

These `.env` values are the main controls for startup speed and resilience:

| Variable | Default | Effect |
| --- | --- | --- |
| `LLM_RETRIES` | `2` | Retries transient LLM failures before falling back. |
| `LLM_RETRY_DELAY_MS` | `1200` | Linear retry delay for LLM failures. |
| `LLM_FALLBACK_PROVIDERS` | `claude_cli` | Comma-separated provider fallback chain after the primary provider fails. |
| `MUSIC_RESOLVE_CONCURRENCY` | `3` | Parallel music lookup count. Ordering is preserved after resolution. |
| `DIRECT_ARTIST_TRACK_COUNT` | `3` | Number of artist-matched tracks for direct artist requests. |
| `SPOTIFY_FAST_START` | `0` | When `1`, Spotify hits skip yt-dlp stream fallback and play through Spotify Web Playback URI. |
| `TTS_SYNTH_CONCURRENCY` | `3` | Parallel DJ segment TTS synthesis count. |
| `TTS_SYNTH_RETRIES` | `2` | Retries transient TTS failures. |
| `OPENING_LEAD_IN_LLM_TIMEOUT_MS` | `2200` | Maximum wait for the short lead-in LLM call before falling back. |
| `OPENING_LEAD_IN_TTS_TIMEOUT_MS` | `4500` | Maximum wait for lead-in TTS before starting without it. |
| `OPENING_CONTINUATION_WINDOW_MS` | `9000` | Time after first-track start during which long opening continuation may still play. |
Use `SPOTIFY_FAST_START=1` only when Spotify Web Playback is authenticated and
the browser player is expected to be ready. The front end waits briefly for the
Spotify device before falling back to a notice.

## Runtime APIs

Useful local endpoints:

| Route | Purpose |
| --- | --- |
| `POST /api/chat` | Main listener input route. |
| `POST /api/radio/refill` | Frontend-triggered music refill. |
| `GET /api/now` | Current `nowPlaying` snapshot. |
| `GET /api/program-arc` | Active program arc or inactive state. |
| `GET /api/environment` | Local time-zone and locale context. |
| `POST /api/environment` | Update local time-zone and locale context. |
| `GET /api/taste` | Static taste file. |
| `GET /api/dj-memory` | Current dynamic DJ memory. |
| `GET /api/spotify/status` | Spotify auth status. |
| `GET /api/spotify/token` | Browser Web Playback SDK token. |
| `POST /api/spotify/play` | Start Spotify playback on a device. |
| `POST /api/tts/caller` | Generate request-line caller voice. |

The server intentionally does not request browser location or call a weather API.
`/api/environment` returns time context only.

## Smoke Tests

Run syntax checks:

```bash
npm run check
```

Start the server on a spare port:

```bash
PORT=8081 npm run start:server
```

Check static runtime endpoints without triggering LLM, TTS, or music resolution:

```bash
curl -sS http://127.0.0.1:8081/api/environment
curl -sS http://127.0.0.1:8081/api/program-arc
curl -sS http://127.0.0.1:8081/api/dj-memory
curl -sS -I http://127.0.0.1:8081/
```

Only test `POST /api/chat` with a real start message when LLM, TTS, and the
chosen music provider are configured and you are ready to spend provider quota.
