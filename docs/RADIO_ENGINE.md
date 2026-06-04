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

Program start jobs now prioritize the first playable track, then block first
playback until the full cold open script and TTS are ready. The browser speaks
the complete cold open before starting the first song.

The remaining startup tracks are resolved by `music_tail_resolve` and appended
with `tracks-ready`. Bridge scripts are generated in background jobs after the
first song path is already moving.

Scheduled openings and hourly checks use the same `program_start` queue. They
skip if another `program_start` is active or queued, and by default they do not
interrupt an already active program. Set `SCHEDULER_INTERRUPT_ACTIVE_PROGRAM=1`
only when scheduled retunes should be allowed to replace the current show.

## Job Queues

There are two queues:

- Foreground queue: `program_start`, `music_tail_resolve`, `music_refill`.
- Background queue: `opening_generation`, `bridge_generation`.

Foreground jobs protect the music supply. Background jobs improve hosting
without blocking first playback.

Important WebSocket events:

- `job-status`: phase and failure updates for UI status text.
- `program-start`: new program, first confirmed tracks, program arc, and the
  complete synthesized cold open segments that should play before the first
  song.
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

On page load, the browser calls `/api/session` before auto-starting. If the
server already has a complete `program-start` payload, the browser hydrates that
payload through the same WebSocket handler so the cold open and first-track
sequence remain intact. If the server only has an active or queued startup job,
the browser waits for the later WebSocket events instead of creating a duplicate
auto-start job.

`tracks-ready` is different: it appends refill tracks to the current program and
does not reset playback.

DJ voice is serialized through a voice channel:

- When `program-start` includes `openingReady`, the browser queues the tracks
  but waits for the complete cold open sequence to finish before starting the
  first song.
- Request-line caller voice blocks immediate DJ interruptions until it finishes.
- Immediate segments are queued and de-duplicated by segment key.
- Bridge segments are delivered at song seams when possible.
- The front end avoids replaying handled segments when late background jobs
  arrive.

## Latency And Reliability Knobs

These `.env` values are the main controls for startup speed and resilience:

| Variable | Default | Effect |
| --- | --- | --- |
| `LLM_PROVIDER` | `codex_cli` | Active writing engine. `codex_cli` runs `codex exec` as a local subprocess. |
| `LLM_FALLBACK_PROVIDERS` | empty | Optional comma-separated fallback chain. Leave empty to fail visibly instead of substituting another writer. |
| `LLM_RETRIES` | `0` | Retries transient LLM failures. Keep `0` with subprocess providers to avoid long repeated waits. |
| `LLM_RETRY_DELAY_MS` | `1200` | Linear retry delay for LLM failures. |
| `LLM_TIMEOUT_MS` | `180000` | Hard timeout for LLM calls, including Codex/Claude subprocess calls. |
| `CODEX_CLI_COMMAND` | `codex` | Command used by the `codex_cli` provider. |
| `CODEX_OUTPUT_SCHEMA` | `schemas/llm-response.schema.json` | JSON schema passed to `codex exec --output-schema`. |
| `MUSIC_RESOLVE_CONCURRENCY` | `3` | Parallel music lookup count. Ordering is preserved after resolution. |
| `DIRECT_ARTIST_TRACK_COUNT` | `3` | Number of artist-matched tracks for direct artist requests. |
| `MUSIC_FALLBACK_PROVIDER` | `none` | Optional music fallback. Set to `yt-dlp` only when stream URL fallback is explicitly wanted. |
| `MUSIC_LOOKUP_CACHE_TTL_MS` | `900000` | In-memory TTL for successful Spotify track and artist lookups. |
| `MUSIC_NEGATIVE_CACHE_TTL_MS` | `120000` | In-memory TTL for failed Spotify lookups. |
| `MUSIC_LOOKUP_CACHE_MAX_ENTRIES` | `200` | Maximum in-memory Spotify lookup cache entries. Oldest entries are pruned first. |
| `SCHEDULER_INTERRUPT_ACTIVE_PROGRAM` | `0` | Set to `1` only if scheduled programs may replace an active show. |
| `SPOTIFY_FAST_START` | `1` | When enabled, Spotify hits skip stream fallback and play through Spotify Web Playback URI. |
| `TTS_SYNTH_CONCURRENCY` | `3` | Parallel DJ segment TTS synthesis count. |
| `TTS_SYNTH_RETRIES` | `2` | Retries transient TTS failures. |
By default, Claudio avoids yt-dlp so direct requests do not wait on video search
or audio extraction. To restore the older stream URL fallback path, set
`MUSIC_FALLBACK_PROVIDER=yt-dlp` and `SPOTIFY_FAST_START=0`.

Unknown direct requests are resolved conservatively: explicit artist requests
such as `play Drake songs` still use artist search first. Direct song commands
such as `播放晴天`, `play Sofia`, quoted CJK titles, short CJK bare inputs, and
uppercase bare titles such as `HUMBLE` try track search first before falling
back to artist search. Vibe commands such as `More like this: ... A - B ...`
are classified before dash-title parsing so they cannot become accidental exact
track requests.

`npm run check` includes `scripts/test-routing.js`, which covers the bilingual
request parser and Spotify candidate scoring edge cases.

## Runtime APIs

Useful local endpoints:

| Route | Purpose |
| --- | --- |
| `POST /api/chat` | Main listener input route. |
| `POST /api/radio/refill` | Frontend-triggered music refill. |
| `GET /api/now` | Current `nowPlaying` snapshot. |
| `GET /api/program-arc` | Active program arc or inactive state. |
| `GET /api/session` | Current server-side program, queue, last startup payload, and job status for page-load hydration. |
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
