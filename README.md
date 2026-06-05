# Claudio FM

**Claudio FM is a private AI radio station.**

It acts like a real DJ: it chooses music, speaks on air, bridges between songs, and keeps the station going based on your taste and the current moment.

Claudio is not a playlist generator or a chatbot that waits for commands. Open it, press play, and it begins programming a small radio show for you. It reads the local time, remembers your recent listening, follows your music taste, and turns each DJ line into spoken audio before the next song comes in.

## Preview

![Claudio FM preview](assets/claudio-fm-preview.png)

## What It Feels Like

Claudio is for moments when you do not want to build a playlist.

You might be working, cooking, resting, or just letting the afternoon pass. Claudio listens to the shape of that moment and creates a short set: a few songs, a warm opening, a bridge between tracks, and sometimes silence when the music should speak for itself.

You can also call into the station through the request line. Claudio can play a caller-style voice moment, take your message as a signal, adjust the mood, and keep the broadcast moving.

## What Claudio Does

- Chooses songs based on your taste and the current time.
- Opens a set with DJ narration.
- Takes listener calls through the request line.
- Distinguishes music requests, feedback, corrections, session context, and ordinary chat.
- Learns from explicit feedback such as liking the current track, avoiding an artist, or asking the DJ to speak less.
- Speaks in short, separate radio segments.
- Bridges between songs like a live host.
- Turns DJ lines into voice with TTS.
- Keeps music buffered so the station can continue.
- Lets you choose whether the DJ speaks English or Chinese.
- Lets you control DJ voice volume and music volume separately.
- Does not request browser location or call a weather API; the runtime context is local time and locale only.

## Why It Is Different

Most music apps help you find tracks.

Claudio tries to make the music feel hosted.

The important part is not just recommendation. It is the feeling that someone is running the station: choosing what fits, saying only what helps, leaving space when needed, and carrying one song into the next.

## Inspiration

The creative inspiration for Claudio FM came from the Douyin creator **mmguo**.

## Running Locally

Install dependencies:

```bash
yarn install
```

Create your environment file:

```bash
cp .env.example .env
```

Then configure the services you want to use, such as your LLM provider, TTS provider, and music provider settings.

### Required Configuration

Claudio uses DeepSeek for DJ planning and Volcengine Doubao Speech for the default DJ voice. Fill these values in `.env`:

```bash
DEEPSEEK_API_KEY=your_deepseek_api_key
VOLCENGINE_TTS_API_KEY=your_volcengine_tts_api_key
VOLCENGINE_TTS_RESOURCE_ID=volc.service_type.10029
VOLCENGINE_TTS_VOICE_TYPE=en_female_nadia_tips_emo_v2_mars_bigtts
```

- Get a DeepSeek API key from [DeepSeek API Keys](https://platform.deepseek.com/api_keys).
- Activate and get the Doubao Speech API key from [Volcengine Speech Settings](https://console.volcengine.com/speech/new/setting/activate?ResourceID=volc.service_type.10029&projectName=default).
- Doubao Speech currently includes 20,000 free characters for the 1.0 voice model and 20,000 free characters for the 2.0 voice model.

### Optional Providers And Reliability

Spotify can be used for music metadata and Web Playback SDK playback. Set these values if you want Spotify support:

```bash
MUSIC_PROVIDER=auto
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8080/auth/spotify/callback
```

Then open `http://localhost:8080/auth/spotify` once to connect your Spotify account. Spotify playback requires Spotify Premium. Claudio stores the local Spotify token under `data/spotify/`, which is ignored by Git.

Kokoro can be used as a local TTS sidecar. `yarn start` starts it automatically when `TTS_PROVIDER=kokoro`; you can also run it manually:

```bash
yarn kokoro:start
# or
npm run kokoro:start
```

Then set `TTS_PROVIDER=kokoro` or `CALLER_TTS_PROVIDER=kokoro` in `.env`.

Codex CLI can be used as the local LLM subprocess provider by setting `LLM_PROVIDER=codex_cli`. Claudio runs `codex exec` with a JSON output schema, read-only sandboxing, and a hard timeout. Leave `LLM_FALLBACK_PROVIDERS` empty when wrong fallback content is worse than a visible failure.

Gemini can still be used as an OpenAI-compatible LLM provider by setting `LLM_PROVIDER=gemini` and `GEMINI_API_KEY`.

Useful reliability and latency knobs:

```bash
LLM_PROVIDER=codex_cli
LLM_FALLBACK_PROVIDERS=
LLM_RETRIES=0
LLM_RETRY_DELAY_MS=1200
LLM_TIMEOUT_MS=180000
CODEX_CLI_COMMAND=codex
CODEX_MODEL=
CODEX_PROFILE=
CODEX_CLI_CONFIG_ARGS=-c model_reasoning_effort=low
CODEX_IGNORE_RULES=1
CODEX_OUTPUT_SCHEMA=schemas/llm-response.schema.json
LLM_SUBPROCESS_CONCURRENCY=1
PROGRAM_START_LLM_TIMEOUT_MS=180000
COLD_OPEN_LLM_TIMEOUT_MS=180000
DIRECT_COLD_OPEN_LLM_TIMEOUT_MS=150000
MUSIC_REFILL_LLM_TIMEOUT_MS=120000
BRIDGE_LLM_TIMEOUT_MS=90000
RADIO_CHAT_LLM_TIMEOUT_MS=90000
TTS_WARMUP_ON_START=1
TTS_CACHE_MAX_AGE_MS=604800000
TTS_CACHE_MAX_FILES=600
MUSIC_RESOLVE_CONCURRENCY=3
DIRECT_ARTIST_TRACK_COUNT=3
MUSIC_FALLBACK_PROVIDER=none
MUSIC_LOOKUP_CACHE_TTL_MS=900000
MUSIC_NEGATIVE_CACHE_TTL_MS=120000
MUSIC_LOOKUP_CACHE_MAX_ENTRIES=200
SCHEDULER_INTERRUPT_ACTIVE_PROGRAM=0
SPOTIFY_FAST_START=1
TTS_SYNTH_CONCURRENCY=3
TTS_SYNTH_RETRIES=2
```

Track lookup and TTS synthesis run with small bounded concurrency. Result ordering and queue de-duplication still follow the original requested track order.
By default, Claudio uses Spotify Web Playback URI fast-start and does not invoke yt-dlp. Set `MUSIC_FALLBACK_PROVIDER=yt-dlp` and `SPOTIFY_FAST_START=0` only when you explicitly want stream-url fallback.
Direct artist requests such as `Drake` or `play Drake songs` search Spotify track results and enqueue up to `DIRECT_ARTIST_TRACK_COUNT` tracks whose artist field matches the requested artist. Short CJK unknown requests and uppercase bare track names such as `HUMBLE` try song-title search first, then fall back to artist search.
Spotify lookup results are cached in memory using `MUSIC_LOOKUP_CACHE_TTL_MS`; misses use the shorter `MUSIC_NEGATIVE_CACHE_TTL_MS`, and the cache is capped by `MUSIC_LOOKUP_CACHE_MAX_ENTRIES`.
Scheduled shows use the same `program_start` path as listener starts. By default they do not interrupt an active program; set `SCHEDULER_INTERRUPT_ACTIVE_PROGRAM=1` to allow scheduled retunes.
At startup, Claudio now resolves the first playable track quickly, then waits for the full cold open script and TTS before starting the first song. Remaining startup tracks continue resolving in the background.

Start Claudio:

```bash
yarn start
```

On startup, Claudio checks the local NeteaseCloudMusicApi sidecar. If
`NETEASE_COOKIE` is not configured and no saved local cookie exists, it creates
a Netease QR login page at `data/netease/qr-login.html`. Scan it with the
Netease Cloud Music app to save a local cookie for later runs. The saved cookie
stays under `data/netease/` and is ignored by Git.

The app also syncs the browser time zone and locale to `/api/environment`. That endpoint intentionally returns time context only; it does not store coordinates, browser geolocation, or weather.

### DJ Personalization

Claudio keeps static taste guidance in `user/taste.md`, `user/routines.md`, and `user/mood-rules.md`.

At runtime, Claudio can also create `user/dj-memory.json` from explicit listener signals:

- `这首歌不错` / `this track is good` can mark the current track and artist as liked.
- `这首歌不好听` / `not this track` can mark the current track as disliked.
- `别播这个歌手` / `do not play this artist` can add an artist avoidance signal.
- `我在工作`, `有点累`, or `I had a rough day` can shape the current session tone.
- `少说点` / `less talking` can make the DJ speak more sparsely.

`user/dj-memory.json` is ignored by Git because it is private local listening data. You can inspect the current runtime memory at:

```text
http://localhost:8080/api/dj-memory
```

The implementation roadmap for making Claudio feel more like a real private DJ lives in `docs/DJ_PERSONALIZATION_GOALS.md`.

The active program arc can be inspected at:

```text
http://localhost:8080/api/program-arc
```

The arc tracks the current set direction, phase, energy curve, and next move. Correction messages such as `不是这种 Drake` or `not this version` create a correction-recovery arc with negative constraints so Claudio can reset the lane instead of treating the message as ordinary chat.

For the radio runtime, job queues, WebSocket events, latency knobs, and smoke tests, see `docs/RADIO_ENGINE.md`.

Open:

```text
http://localhost:8080
```

Run a quick syntax check:

```bash
yarn check
# or
npm run check
```

### Troubleshooting

If the terminal says `LLM unavailable` or the UI says Claudio took too long to write the link, the active LLM provider failed or timed out. With `LLM_FALLBACK_PROVIDERS=` Claudio does not substitute another model or backup writer; it shows the failure so the listener can retry.

If you hear a backup-style opening, it means every configured LLM provider failed or returned no usable tracks. Check the lines immediately above it in the terminal for the provider error and whether the fallback provider was attempted.

If Kokoro logs `fetch failed`, keep the Kokoro sidecar running and let `TTS_SYNTH_RETRIES` retry transient local TTS failures. Reduce `TTS_SYNTH_CONCURRENCY` to `1` if the local machine struggles with parallel synthesis.

## Current Version

`v1.1.1` is the single-user radio version.

It is designed for one local listener experience: one private station, one local playback session, and one AI DJ running the show.

---

# Claudio FM 中文介绍

![Claudio FM preview](assets/claudio-fm-preview.png)

**Claudio FM 是一个 AI 私人电台。**

它会像真正的 DJ 一样，根据你的品味和当下时刻，自动选歌、播报、串场和续播。

Claudio 不是歌单生成器，也不是等你下命令的聊天机器人。你打开它，按下播放，它就开始为你经营一小段电台节目：看本地时间，参考你的音乐品味和播放历史，挑几首合适的歌，再把每一句 DJ 播报转成语音，插入到音乐之间。

## 它听起来像什么

Claudio 适合那些你不想自己整理歌单的时刻。

你可能在工作、做饭、休息，或者只是想让下午自然流过去。Claudio 会感知这个时刻的气氛，生成一小组节目：几首歌，一段开场，歌曲之间的串场，以及在该安静时的留白。

你也可以通过 request line 打进电台。Claudio 会播放一段类似听众来电的声音，把你的话当成一个信号，调整接下来的节目方向，然后继续播下去。

## Claudio FM 会做什么

- 根据你的品味和当前时间选歌。
- 在一组歌曲开始前进行 DJ 开场。
- 通过 request line 接听听众来电。
- 把播报拆成一句一句的电台片段。
- 像真实主持人一样在歌曲之间串场。
- 用 TTS 把 DJ 文案转成语音。
- 自动补歌，让电台继续播下去。
- 支持选择 DJ 使用英文或中文播报。
- 支持分别控制 DJ 音量和音乐音量。
- 不请求浏览器定位，也不调用天气 API；运行上下文只使用本地时间和 locale。

## 它特别在哪里

大多数音乐产品是在帮你找歌。

Claudio 想做的是让音乐“有人主持”。

重点不只是推荐了哪几首歌，而是有一个 AI DJ 在后台运营这档节目：判断当下适合什么，知道什么时候该说话，什么时候该安静，以及如何把一首歌自然带到下一首歌。

## 创意来源

Claudio FM 的创意灵感来自抖音博主 **mmguo**。

## 本地运行

安装依赖：

```bash
yarn install
```

创建环境变量文件：

```bash
cp .env.example .env
```

然后配置你要使用的 LLM、TTS 和音乐服务。

### 必要配置

Claudio 默认使用 DeepSeek 生成 DJ 节目内容，使用火山引擎豆包语音生成 DJ 声音。请在 `.env` 中填写：

```bash
DEEPSEEK_API_KEY=你的_DeepSeek_API_Key
VOLCENGINE_TTS_API_KEY=你的_火山引擎_豆包语音_API_Key
VOLCENGINE_TTS_RESOURCE_ID=volc.service_type.10029
VOLCENGINE_TTS_VOICE_TYPE=en_female_nadia_tips_emo_v2_mars_bigtts
```

- DeepSeek API Key 获取地址：[DeepSeek API Keys](https://platform.deepseek.com/api_keys)。
- 豆包语音 API Key 激活与获取地址：[火山引擎语音技术控制台](https://console.volcengine.com/speech/new/setting/activate?ResourceID=volc.service_type.10029&projectName=default)。
- 豆包语音目前赠送 1.0 语音模型 20,000 字免费用量，以及 2.0 语音模型 20,000 字免费用量。

### 可选服务与稳定性

Spotify 可用于音乐元数据和 Web Playback SDK 播放。需要启用时填写：

```bash
MUSIC_PROVIDER=auto
SPOTIFY_CLIENT_ID=你的_Spotify_Client_ID
SPOTIFY_CLIENT_SECRET=你的_Spotify_Client_Secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8080/auth/spotify/callback
```

然后打开 `http://localhost:8080/auth/spotify` 完成一次授权。Spotify 播放需要 Spotify Premium；本地 token 会保存在 `data/spotify/`，该目录已被 Git 忽略。

Kokoro 可作为本地 TTS sidecar。`yarn start` 会在 `TTS_PROVIDER=kokoro` 时自动启动它；也可以手动运行：

```bash
yarn kokoro:start
# 或
npm run kokoro:start
```

然后在 `.env` 中设置 `TTS_PROVIDER=kokoro` 或 `CALLER_TTS_PROVIDER=kokoro`。

Codex CLI 可以作为本地 LLM 子进程 provider：设置 `LLM_PROVIDER=codex_cli`。Claudio 会用 JSON schema、read-only sandbox 和硬超时调用 `codex exec`。如果错误 fallback 内容比明确失败更糟，保持 `LLM_FALLBACK_PROVIDERS` 为空。

Gemini 仍可作为兼容 OpenAI SDK 的 LLM provider：设置 `LLM_PROVIDER=gemini` 和 `GEMINI_API_KEY` 即可。

常用稳定性和延迟参数：

```bash
LLM_PROVIDER=codex_cli
LLM_FALLBACK_PROVIDERS=
LLM_RETRIES=0
LLM_RETRY_DELAY_MS=1200
LLM_TIMEOUT_MS=180000
CODEX_CLI_COMMAND=codex
CODEX_MODEL=
CODEX_PROFILE=
CODEX_CLI_CONFIG_ARGS=-c model_reasoning_effort=low
CODEX_OUTPUT_SCHEMA=schemas/llm-response.schema.json
CODEX_IGNORE_RULES=1
LLM_SUBPROCESS_CONCURRENCY=1
PROGRAM_START_LLM_TIMEOUT_MS=180000
COLD_OPEN_LLM_TIMEOUT_MS=180000
DIRECT_COLD_OPEN_LLM_TIMEOUT_MS=150000
MUSIC_REFILL_LLM_TIMEOUT_MS=120000
BRIDGE_LLM_TIMEOUT_MS=90000
RADIO_CHAT_LLM_TIMEOUT_MS=90000
TTS_WARMUP_ON_START=1
TTS_CACHE_MAX_AGE_MS=604800000
TTS_CACHE_MAX_FILES=600
MUSIC_RESOLVE_CONCURRENCY=3
DIRECT_ARTIST_TRACK_COUNT=3
MUSIC_FALLBACK_PROVIDER=none
MUSIC_LOOKUP_CACHE_TTL_MS=900000
MUSIC_NEGATIVE_CACHE_TTL_MS=120000
MUSIC_LOOKUP_CACHE_MAX_ENTRIES=200
SCHEDULER_INTERRUPT_ACTIVE_PROGRAM=0
SPOTIFY_FAST_START=1
TTS_SYNTH_CONCURRENCY=3
TTS_SYNTH_RETRIES=2
```

默认情况下，Claudio 使用 Spotify Web Playback URI 快速启动，不调用 yt-dlp。只有明确需要 stream URL fallback 时，才设置 `MUSIC_FALLBACK_PROVIDER=yt-dlp` 并把 `SPOTIFY_FAST_START=0`。

歌曲解析和 TTS 合成会用小并发执行，但最终结果顺序和队列去重仍按原始请求曲目顺序处理。
直接歌手点歌，例如 `Drake` 或 `play Drake songs`，会搜索 Spotify track 结果，并加入最多 `DIRECT_ARTIST_TRACK_COUNT` 首 artist 字段匹配该歌手的曲目。短中文未知点歌和 `HUMBLE` 这种全大写裸输入会先按歌名搜索，未命中再尝试歌手搜索。
Spotify 搜索结果会用 `MUSIC_LOOKUP_CACHE_TTL_MS` 做内存缓存；未命中结果用较短的 `MUSIC_NEGATIVE_CACHE_TTL_MS`，总条数由 `MUSIC_LOOKUP_CACHE_MAX_ENTRIES` 限制。
定时节目现在和用户开台走同一条 `program_start` 链路。默认不会打断活跃节目；如果需要整点强制换台，可设置 `SCHEDULER_INTERRUPT_ACTIVE_PROGRAM=1`。
启动时，Claudio 会先快速解析第一首可播放歌曲，然后等待完整 cold open 文案和 TTS 完成，再播放第一首歌；剩余启动曲目继续在后台解析。

启动 Claudio：

```bash
yarn start
```

启动时，Claudio 会检查本地 NeteaseCloudMusicApi sidecar。如果没有配置
`NETEASE_COOKIE`，也没有已保存的本地 cookie，它会生成网易云二维码登录页：
`data/netease/qr-login.html`。用网易云音乐 App 扫码后，Claudio 会把 cookie
保存到 `data/netease/`，后续启动自动复用；该目录会被 Git 忽略。

应用还会把浏览器 time zone 和 locale 同步到 `/api/environment`。该接口只返回时间上下文，不保存坐标、浏览器定位或天气。

电台运行状态机、任务队列、WebSocket 事件、延迟参数和 smoke test 记录在 `docs/RADIO_ENGINE.md`。

打开：

```text
http://localhost:8080
```

运行快速语法检查：

```bash
yarn check
# 或
npm run check
```

### 故障排查

如果终端出现 `LLM unavailable`，或 UI 提示 Claudio 写文案超时，说明当前 LLM provider 失败或超时。配置 `LLM_FALLBACK_PROVIDERS=` 时，Claudio 不会切换备用模型或备用文案，而是明确提示用户重试。

如果听到备用开场，说明所有已配置 LLM provider 都失败，或没有返回可用曲目。看它前面的终端日志，可以确认具体 provider 错误以及是否已尝试 fallback。

如果 Kokoro 出现 `fetch failed`，保持 Kokoro sidecar 运行，让 `TTS_SYNTH_RETRIES` 处理短暂失败。如果本机并行合成压力过大，把 `TTS_SYNTH_CONCURRENCY` 调低到 `1`。

## 当前版本

`v1.1.1` 是单人电台版本。

它面向一个本地听众体验：一个私人电台、一个本地播放会话，以及一个在后台运营节目的 AI DJ。
