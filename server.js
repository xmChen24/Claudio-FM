require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { route } = require('./router');
const { buildPrompt, buildProgramStartPrompt, buildOpeningLeadInPrompt, buildColdOpenForTracksPrompt, buildMusicRefillPrompt, buildBridgePrompt } = require('./context');
const { callClaude } = require('./claude');
const { synthesize } = require('./tts');
const { getTrack, getArtistTracks } = require('./music');
const { addPlay, addMessage, recentPlays, getPref } = require('./state');
const { environmentSnapshot, updateEnvironment } = require('./env-context');
const { captureUserSignal, loadDjMemory } = require('./dj-memory');
const { createProgramArc, extendProgramArc } = require('./program-arc');
const { buildCorrectionContext } = require('./dj-correction');
const scheduler = require('./scheduler');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.CLAUDIO_HOST || process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGINS = new Set(
  (process.env.CLAUDIO_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => normalizedOrigin(origin.trim()))
    .filter(Boolean)
);
const TTS_CACHE_DIR = path.resolve(__dirname, 'cache/tts');
const TTS_CACHE_FILENAME = /^[a-f0-9]{32}\.(mp3|wav)$/i;

function normalizedOrigin(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function isTrustedOrigin(value) {
  if (!value) return true;
  const origin = normalizedOrigin(value);
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;

  try {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      isLoopbackHost(url.hostname) &&
      port === String(PORT);
  } catch {
    return false;
  }
}

function isTrustedLocalRequest(req) {
  if (req.headers.origin) return isTrustedOrigin(req.headers.origin);
  if (req.headers.referer && !isTrustedOrigin(req.headers.referer)) return false;
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

function requireTrustedLocalRequest(req, res, next) {
  if (isTrustedLocalRequest(req)) return next();
  return res.status(403).json({ error: 'forbidden_origin' });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/stream',
  verifyClient: ({ req, origin }, done) => {
    done(isTrustedLocalRequest({
      headers: {
        ...req.headers,
        origin,
      },
    }), 403, 'Forbidden');
  },
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'pwa')));
app.use(['/api', '/auth'], requireTrustedLocalRequest);
app.use(express.json());

// ── WebSocket broadcast ──────────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  sendTtsUnavailableIfNeeded(ws);
  ws.on('close', () => clients.delete(ws));
});

function sendSystemLog(ws, level, message, details = {}) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: 'system-log',
    level,
    message,
    details,
    at: Date.now(),
  }));
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function broadcastSystemLog(level, message, details = {}) {
  for (const ws of clients) sendSystemLog(ws, level, message, details);
}

function kokoroBaseUrl() {
  return (process.env.KOKORO_API_BASE || 'http://127.0.0.1:8880').replace(/\/+$/, '');
}

function userFacingSystemMessage(message = '') {
  if (/tts not started|kokoro unreachable|voice engine|tts.*unreachable/i.test(message)) {
    return 'Voice engine is offline. Claudio can keep the music moving while voice warms up.';
  }
  if (/fallback|backup/i.test(message)) {
    return 'Main signal is slow, so Claudio is opening a backup set.';
  }
  return message;
}

function broadcastUserSystemLog(level, message, details = {}) {
  broadcastSystemLog(level, message, {
    ...details,
    userMessage: details.userMessage || userFacingSystemMessage(message),
  });
}

function metricTimer(label) {
  const startedAt = Date.now();
  const marks = {};
  return {
    mark(name) {
      marks[name] = Date.now() - startedAt;
      console.log(`[metric:${label}] ${name}=${marks[name]}ms`);
    },
    snapshot(extra = {}) {
      return { label, totalMs: Date.now() - startedAt, ...marks, ...extra };
    },
  };
}

function softTimeout(promise, timeoutMs, label, fallbackValue = null) {
  let settled = false;
  const guarded = Promise.resolve(promise)
    .then(value => {
      settled = true;
      return value;
    })
    .catch(err => {
      settled = true;
      console.warn(`[${label}] ${err.message}`);
      return fallbackValue;
    });
  const timeout = new Promise(resolve => {
    setTimeout(() => {
      if (!settled) console.warn(`[${label}] timed out after ${timeoutMs}ms`);
      resolve(fallbackValue);
    }, timeoutMs);
  });
  return Promise.race([guarded, timeout]);
}

async function sendTtsUnavailableIfNeeded(ws) {
  if ((process.env.TTS_PROVIDER || 'volcengine') !== 'kokoro') return;

  const baseUrl = kokoroBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    sendSystemLog(ws, 'error', `tts not started: Kokoro unreachable at ${baseUrl}`, {
      error: err.name === 'AbortError' ? 'health check timed out' : err.message,
      userMessage: userFacingSystemMessage('tts not started'),
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Current playback state ───────────────────────────────────────────────────
let nowPlaying = null;

const STATION_NAME = 'Claudio FM';
const PROGRAM_NAME = 'Evening Drive';
const REFILL_TRACK_COUNT = 3;
const TRACK_REPEAT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ARTIST_RECENT_WINDOW = 5;
const MUSIC_RESOLVE_CONCURRENCY = Math.max(1, Number(process.env.MUSIC_RESOLVE_CONCURRENCY || 3));
const TTS_SYNTH_CONCURRENCY = Math.max(1, Number(process.env.TTS_SYNTH_CONCURRENCY || 3));
const TTS_SYNTH_RETRIES = Math.max(0, Number(process.env.TTS_SYNTH_RETRIES || 2));
const DIRECT_ARTIST_TRACK_COUNT = Math.max(1, Number(process.env.DIRECT_ARTIST_TRACK_COUNT || 3));
const OPENING_LEAD_IN_LLM_TIMEOUT_MS = Math.max(500, Number(process.env.OPENING_LEAD_IN_LLM_TIMEOUT_MS || 2200));
const OPENING_LEAD_IN_TTS_TIMEOUT_MS = Math.max(500, Number(process.env.OPENING_LEAD_IN_TTS_TIMEOUT_MS || 4500));
const OPENING_CONTINUATION_WINDOW_MS = Math.max(0, Number(process.env.OPENING_CONTINUATION_WINDOW_MS || 9000));
const FALLBACK_PROGRAM_TRACKS = [
  'Sweet Disposition - The Temper Trap',
  'Ventura Highway - America',
  'Pink Moon - Nick Drake',
  '1901 - Phoenix',
  'This Must Be the Place - Talking Heads',
];
const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');
const SPOTIFY_TOKEN_PATH = path.join(__dirname, 'data', 'spotify', 'token.json');
const SPOTIFY_STATE_PATH = path.join(__dirname, 'data', 'spotify', 'state.json');
const SPOTIFY_STATE_TTL_MS = 10 * 60 * 1000;

const stationState = {
  programId: null,
  sessionTitle: '',
  tracks: [],
  programArc: null,
  lastMusicIntent: null,
  lastCorrectionContext: null,
  foregroundJobs: [],
  backgroundJobs: [],
  jobKeys: new Set(),
  foregroundWorkerRunning: false,
  backgroundWorkerRunning: false,
};

function normalizeDjLanguage(value) {
  return value === 'zh' ? 'zh' : 'en';
}

function normalizeHostMode(value) {
  return ['quiet', 'story', 'companion'].includes(value) ? value : 'story';
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function spotifyRedirectUri(req) {
  return process.env.SPOTIFY_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/spotify/callback`;
}

function spotifyCredentials() {
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  };
}

function readSpotifyToken() {
  try {
    return JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeSpotifyToken(token) {
  ensureDirForFile(SPOTIFY_TOKEN_PATH);
  fs.writeFileSync(SPOTIFY_TOKEN_PATH, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

function readSpotifyState() {
  try {
    return JSON.parse(fs.readFileSync(SPOTIFY_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeSpotifyState(state) {
  ensureDirForFile(SPOTIFY_STATE_PATH);
  fs.writeFileSync(SPOTIFY_STATE_PATH, `${JSON.stringify({
    state,
    expires_at: Date.now() + SPOTIFY_STATE_TTL_MS,
  }, null, 2)}\n`, { mode: 0o600 });
}

function consumeSpotifyState(state) {
  const saved = readSpotifyState();
  fs.rmSync(SPOTIFY_STATE_PATH, { force: true });
  return !!state && saved?.state === state && Number(saved.expires_at) > Date.now();
}

async function requestSpotifyToken(body, req) {
  const { clientId, clientSecret } = spotifyCredentials();
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set');
  const params = { ...body };
  if (body.grant_type !== 'refresh_token') params.redirect_uri = spotifyRedirectUri(req);

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Spotify token error ${res.status}: ${payload.error_description || payload.error || 'unknown error'}`);
  }
  return payload;
}

async function getSpotifyUserToken(req) {
  const saved = readSpotifyToken();
  if (!saved?.refresh_token && !saved?.access_token) return null;

  if (saved.access_token && saved.expires_at && saved.expires_at > Date.now() + 60000) {
    return saved;
  }

  if (!saved.refresh_token) return saved;

  const refreshed = await requestSpotifyToken({
    grant_type: 'refresh_token',
    refresh_token: saved.refresh_token,
  }, req);
  const next = {
    ...saved,
    access_token: refreshed.access_token,
    token_type: refreshed.token_type || saved.token_type || 'Bearer',
    scope: refreshed.scope || saved.scope || SPOTIFY_SCOPES,
    expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
    refresh_token: refreshed.refresh_token || saved.refresh_token,
    updated_at: new Date().toISOString(),
  };
  writeSpotifyToken(next);
  return next;
}

function buildAnnouncement(result, tracks, failedTracks, speechOnly) {
  const firstSegmentText = result.segments?.find(s => s?.text)?.text;
  if (firstSegmentText) return firstSegmentText.trim();
  if (result.say) return result.say.trim();
  if (!speechOnly && !tracks.length && failedTracks.length) {
    return "I couldn't get a clean playable link for that set, so I'm keeping the current signal alive.";
  }
  return '';
}

function fallbackProgramStartResult(job = {}, reason = '') {
  const djLanguage = normalizeDjLanguage(job.djLanguage);
  const isZh = djLanguage === 'zh';
  return {
    title: isZh ? '午夜备用信号' : 'Emergency Night Signal',
    play: FALLBACK_PROGRAM_TRACKS,
    segments: isZh ? [
      {
        type: 'cold_open',
        groupId: 'open_0',
        part: 'anchor',
        position: 'before_track',
        trackIndex: 0,
        text: 'Claudio 先从一组稳定的夜间歌单开始，把信号慢慢打开。',
      },
      {
        type: 'cold_open',
        groupId: 'open_0',
        part: 'invitation',
        position: 'before_track',
        trackIndex: 0,
        text: '把音量放低一点，我们继续在空中发射。',
      },
    ] : [
      {
        type: 'cold_open',
        groupId: 'open_0',
        part: 'anchor',
        position: 'before_track',
        trackIndex: 0,
        text: 'Claudio is opening with a steady night set while the signal settles in.',
      },
      {
        type: 'cold_open',
        groupId: 'open_0',
        part: 'invitation',
        position: 'before_track',
        trackIndex: 0,
        text: 'Keep it low and let the station drift back into the sky.',
      },
    ],
    reason: reason ? `fallback: ${reason}` : 'fallback program start',
  };
}

function makeSegmentId(index) {
  return `seg_${Date.now()}_${index}`;
}

function normalizeSegment(raw, index, trackCount) {
  if (!raw || typeof raw !== 'object') return null;
  const allowedTypes = new Set(['cold_open', 'bridge', 'quick_touch', 'back_announce', 'silence']);
  const allowedPositions = new Set(['before_track', 'between_tracks', 'after_track', 'immediate']);
  const type = allowedTypes.has(raw.type) ? raw.type : 'quick_touch';
  const defaultPosition = type === 'bridge' ? 'between_tracks' : type === 'cold_open' ? 'before_track' : 'immediate';
  const position = allowedPositions.has(raw.position) ? raw.position : defaultPosition;
  const segment = {
    id: raw.id || makeSegmentId(index),
    type,
    position,
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
    status: type === 'silence' ? 'silent' : 'pending',
  };

  if (typeof raw.groupId === 'string' && raw.groupId.trim()) segment.groupId = raw.groupId.trim();
  if (typeof raw.part === 'string' && raw.part.trim()) segment.part = raw.part.trim();
  if (Number.isInteger(raw.partIndex)) segment.partIndex = Math.max(0, raw.partIndex);
  if (Number.isInteger(raw.partCount)) segment.partCount = Math.max(1, raw.partCount);

  if (Number.isInteger(raw.trackIndex)) {
    segment.trackIndex = Math.max(0, Math.min(raw.trackIndex, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.afterTrackIndex)) {
    segment.afterTrackIndex = Math.max(0, Math.min(raw.afterTrackIndex, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.beforeTrackIndex)) {
    segment.beforeTrackIndex = Math.max(0, Math.min(raw.beforeTrackIndex, Math.max(0, trackCount - 1)));
  }

  if (position === 'before_track' && segment.trackIndex === undefined) segment.trackIndex = 0;
  if (position === 'between_tracks') {
    if (segment.afterTrackIndex === undefined) segment.afterTrackIndex = Math.max(0, (segment.beforeTrackIndex ?? index) - 1);
    if (segment.beforeTrackIndex === undefined) segment.beforeTrackIndex = Math.min(trackCount - 1, segment.afterTrackIndex + 1);
  }
  if (!trackCount && ['before_track', 'between_tracks', 'after_track'].includes(position)) {
    segment.position = 'immediate';
    delete segment.trackIndex;
    delete segment.afterTrackIndex;
    delete segment.beforeTrackIndex;
  }
  return segment;
}

function splitSentences(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const pieces = normalized.match(/[^.!?。！？]+[.!?。！？"'’”)\]]*/g);
  return (pieces || [normalized]).map(s => s.trim()).filter(Boolean);
}

function expandColdOpenParts(segments) {
  const defaultParts = ['anchor', 'heart', 'turn', 'image', 'invitation'];
  const expanded = [];

  for (const segment of segments) {
    if (segment.type !== 'cold_open' || !segment.text || segment.part) {
      expanded.push(segment);
      continue;
    }

    const sentences = splitSentences(segment.text);
    if (sentences.length <= 1) {
      expanded.push(segment);
      continue;
    }

    const groupId = segment.groupId || segment.id || makeSegmentId(expanded.length);
    sentences.forEach((text, partIndex) => {
      expanded.push({
        ...segment,
        id: `${groupId}_${partIndex}`,
        groupId,
        part: defaultParts[partIndex] || 'line',
        partIndex,
        partCount: sentences.length,
        text,
      });
    });
  }

  return expanded;
}

function normalizeSegments(result, tracks, speechOnly, failedTracks) {
  const trackCount = tracks.length;
  let segments = Array.isArray(result.segments)
    ? result.segments.map((s, i) => normalizeSegment(s, i, trackCount)).filter(Boolean)
    : [];

  if (!segments.length) {
    if (result.say) {
      segments.push(normalizeSegment({
        type: speechOnly ? 'quick_touch' : 'cold_open',
        position: speechOnly ? 'immediate' : 'before_track',
        trackIndex: 0,
        text: result.say,
      }, 0, trackCount));
    }
    if (!speechOnly && Array.isArray(result.intros)) {
      result.intros.forEach((text, i) => {
        if (i === 0 || !text) return;
        segments.push(normalizeSegment({
          type: 'bridge',
          position: 'between_tracks',
          afterTrackIndex: i - 1,
          beforeTrackIndex: i,
          text,
        }, segments.length, trackCount));
      });
    }
  }

  if (!speechOnly && !trackCount && failedTracks.length && !segments.some(s => s?.text)) {
    segments.push(normalizeSegment({
      type: 'quick_touch',
      position: 'immediate',
      text: "I couldn't get a clean playable link for that set, so I'm keeping the current signal alive.",
    }, segments.length, trackCount));
  }

  return expandColdOpenParts(segments.filter(Boolean)).map((segment, index) => ({
    ...segment,
    id: segment.id || makeSegmentId(index),
  }));
}

async function synthesizeSegments(segments) {
  async function synthesizeOne(segment) {
    if (segment.type === 'silence' || !segment.text) {
      segment.status = 'silent';
      return;
    }
    try {
      console.log(`[TTS] 合成 ${segment.type} (${segment.text.length} 字): "${segment.text.slice(0, 50)}…"`);
      const f = await synthesizeWithRetry(segment.text);
      segment.ttsUrl = '/api/tts/' + path.basename(f);
      segment.status = 'ready';
      console.log(`[TTS] ${segment.type} 完成 → ${path.basename(f)}`);
    } catch (err) {
      segment.status = 'tts_failed';
      segment.error = err.message;
      console.error(`[TTS] ${segment.type} 合成失败:`, err.message);
      const provider = process.env.TTS_PROVIDER || 'volcengine';
      if (provider === 'kokoro' && /fetch failed|ECONNREFUSED|failed/i.test(err.message)) {
        broadcastUserSystemLog('error', `tts not started: Kokoro unreachable at ${kokoroBaseUrl()}`, {
          error: err.message,
        });
      }
    }
  }

  await mapWithConcurrency(segments, TTS_SYNTH_CONCURRENCY, synthesizeOne);
  return segments;
}

function extractLeadInText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.openingLeadIn === 'string') return value.openingLeadIn.trim();
  if (value.segment) return extractLeadInText(value.segment);
  if (Array.isArray(value.segments)) {
    const segment = value.segments.find(item => item?.text);
    return extractLeadInText(segment);
  }
  return '';
}

function fallbackOpeningLeadIn(firstTrack, djLanguage = 'en') {
  const title = firstTrack?.title || firstTrack?.query || '';
  const artist = firstTrack?.artist || '';
  const label = artist ? `${title} — ${artist}` : title;
  const variants = normalizeDjLanguage(djLanguage) === 'zh'
    ? [
      label ? `先让 ${label} 把这段信号点亮。` : '先把这段信号轻轻打开。',
      label ? `从 ${label} 的第一层颜色进来。` : '从第一层声音慢慢进来。',
      label ? `${label} 会先把房间带进去。` : '让第一首歌先把房间带进去。',
    ]
    : [
      label ? `${label} is where this signal first finds its shape.` : 'The signal opens with a little room to breathe.',
      label ? `We start inside the first color of ${label}.` : 'We start with the first color of the room.',
      label ? `${label} gets the room first.` : 'The first record gets the room first.',
    ];
  const index = Math.abs(hashText(label || String(Date.now()))) % variants.length;
  return variants[index];
}

function hashText(value) {
  let hash = 0;
  for (const char of String(value || '')) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0);
    hash |= 0;
  }
  return hash;
}

function isStaleProgramJob(job) {
  return Boolean(job?.programId && stationState.programId && job.programId !== stationState.programId);
}

async function buildOpeningLeadInSegment(job, result, tracks, programArc, timing) {
  const firstTrack = tracks[0] || null;
  if (!firstTrack) return null;

  const prompt = buildOpeningLeadInPrompt({
    programTitle: result.title || '',
    firstTrack,
    userInput: job.input || 'Open the station.',
    userIntent: job.userIntent,
    musicRequest: job.musicRequest,
    programArc,
    correctionContext: job.correctionContext,
    djLanguage: job.djLanguage,
    hostMode: job.hostMode,
    seed: result.openingLeadIn || '',
  });

  const leadInResult = await softTimeout(
    callClaude(prompt),
    OPENING_LEAD_IN_LLM_TIMEOUT_MS,
    'opening_lead_in',
    null
  );
  if (leadInResult) timing.mark('lead_in_write_ms');

  const text = extractLeadInText(leadInResult) ||
    extractLeadInText(result.openingLeadIn) ||
    fallbackOpeningLeadIn(firstTrack, job.djLanguage);
  if (!text) return null;

  const segment = normalizeSegment({
    type: 'cold_open',
    groupId: 'open_0',
    part: 'lead_in',
    partIndex: 0,
    position: 'before_track',
    trackIndex: 0,
    text,
  }, 0, tracks.length);

  const synthesized = await softTimeout(
    synthesizeSegments([segment]),
    OPENING_LEAD_IN_TTS_TIMEOUT_MS,
    'opening_lead_in_tts',
    null
  );
  if (!synthesized?.[0]?.ttsUrl) return null;
  timing.mark('lead_in_voice_ms');
  return synthesized[0];
}

async function synthesizeWithRetry(text, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= TTS_SYNTH_RETRIES; attempt++) {
    try {
      return await synthesize(text, options);
    } catch (err) {
      lastError = err;
      if (attempt >= TTS_SYNTH_RETRIES || !isRetryableAudioError(err)) break;
      const delayMs = 600 * (attempt + 1);
      console.warn(`[TTS] retry ${attempt + 1}/${TTS_SYNTH_RETRIES} after ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function isRetryableAudioError(err) {
  const message = String(err?.message || '');
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|\b(429|500|502|503|504)\b/i.test(message);
}

function applyLegacyTrackIntrosFromSegments(tracks, segments) {
  for (const segment of segments) {
    if (!segment.ttsUrl || !segment.text) continue;
    if (segment.position === 'between_tracks' && Number.isInteger(segment.beforeTrackIndex)) {
      const track = tracks[segment.beforeTrackIndex];
      if (track && !track.introTtsUrl) {
        track.introTtsUrl = segment.ttsUrl;
        track.introTranscript = segment.text;
        track.segmentId = segment.id;
      }
    }
  }
}

function makeProgramId() {
  return `program_${Date.now()}`;
}

function callerTtsOptions() {
  const provider = process.env.CALLER_TTS_PROVIDER || process.env.TTS_PROVIDER || 'volcengine';
  return {
    role: 'caller',
    provider,
    apiKey: process.env.CALLER_TTS_API_KEY || process.env.VOLCENGINE_TTS_API_KEY,
    endpoint: process.env.CALLER_TTS_ENDPOINT || process.env.VOLCENGINE_TTS_ENDPOINT,
    resourceId: process.env.CALLER_TTS_RESOURCE_ID || process.env.VOLCENGINE_TTS_RESOURCE_ID,
    voiceType: process.env.CALLER_TTS_VOICE_TYPE || process.env.VOLCENGINE_TTS_VOICE_TYPE,
    voiceId: process.env.CALLER_FISH_VOICE_ID || process.env.FISH_VOICE_ID,
    voice: process.env.CALLER_KOKORO_VOICE || process.env.KOKORO_VOICE,
    model: process.env.CALLER_KOKORO_MODEL || process.env.KOKORO_MODEL,
    baseUrl: process.env.CALLER_KOKORO_API_BASE || process.env.KOKORO_API_BASE,
    format: process.env.CALLER_TTS_FORMAT || (provider === 'kokoro' ? process.env.KOKORO_RESPONSE_FORMAT : process.env.VOLCENGINE_TTS_FORMAT),
    sampleRate: process.env.CALLER_TTS_SAMPLE_RATE || process.env.VOLCENGINE_TTS_SAMPLE_RATE,
    additions: process.env.CALLER_TTS_ADDITIONS || process.env.VOLCENGINE_TTS_ADDITIONS,
  };
}

function trackLabel(track) {
  if (!track) return '';
  return `${track.title || track.query || ''}${track.artist ? ' — ' + track.artist : ''}`.trim();
}

function normalizeTrackText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[這麼們個愛聽與夢風雲臺台裡裏為無後會國樂歡聲當讓開關過還點對萬]/g, char => ({
      '這': '这',
      '麼': '么',
      '們': '们',
      '個': '个',
      '愛': '爱',
      '聽': '听',
      '與': '与',
      '夢': '梦',
      '風': '风',
      '雲': '云',
      '臺': '台',
      '裡': '里',
      '裏': '里',
      '為': '为',
      '無': '无',
      '後': '后',
      '會': '会',
      '國': '国',
      '樂': '乐',
      '歡': '欢',
      '聲': '声',
      '當': '当',
      '讓': '让',
      '開': '开',
      '關': '关',
      '過': '过',
      '還': '还',
      '點': '点',
      '對': '对',
      '萬': '万',
    }[char] || char))
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trackIdentity(track) {
  const title = normalizeTrackText(track?.title || track?.query || '');
  const artist = normalizeTrackText(track?.artist || '');
  return artist ? `${title}::${artist}` : title;
}

function trackUrlIdentity(track) {
  return String(track?.spotifyUri || track?.streamUrl || track?.source_url || '').trim();
}

function parseRequestedTrack(query) {
  const parts = String(query || '').split(/\s+-\s+/);
  return {
    title: parts[0]?.trim() || String(query || '').trim(),
    artist: parts.slice(1).join(' - ').trim(),
  };
}

function trackMatchesRequest(requested, resolved) {
  const requestedTitle = normalizeTrackText(requested.title);
  const requestedArtist = normalizeTrackText(requested.artist);
  const resolvedTitle = normalizeTrackText(resolved.title);
  const resolvedArtist = normalizeTrackText(resolved.artist);
  if (!requestedTitle || !resolvedTitle) return true;

  const titleScore = titleMatchScore(requestedTitle, resolvedTitle);
  const titleMatches = titleScore >= 70;
  const artistMatches = !requestedArtist || !resolvedArtist ||
    requestedArtist === resolvedArtist ||
    requestedArtist.includes(resolvedArtist) ||
    resolvedArtist.includes(requestedArtist);
  const allowCjkArtistAlias = Boolean(requestedArtist && hasCjk(requested.artist) && titleScore >= 95);

  return titleMatches && (artistMatches || allowCjkArtistAlias);
}

function titleMatchScore(requestedTitle, resolvedTitle) {
  if (!requestedTitle || !resolvedTitle) return 0;
  if (requestedTitle === resolvedTitle) return 120;
  if (resolvedTitle.includes(requestedTitle)) return 100;
  if (requestedTitle.includes(resolvedTitle) && resolvedTitle.length >= 2) return 85;
  const requestedTokens = requestedTitle.split(' ').filter(Boolean);
  const resolvedTokens = resolvedTitle.split(' ').filter(Boolean);
  if (!requestedTokens.length || !resolvedTokens.length) return 0;
  const overlap = requestedTokens.filter(token => resolvedTokens.includes(token)).length;
  const ratio = overlap / Math.max(requestedTokens.length, 1);
  if (ratio >= 0.8) return 75;
  if (ratio >= 0.5) return 50;
  return 0;
}

function hasCjk(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(String(value || ''));
}

function payloadTrackFromResolved(query, requested, track) {
  return {
    query,
    title: track.title || requested.title || query,
    artist: track.artist || requested.artist || '',
    streamUrl: track.streamUrl || '',
    source: track.source || '',
    spotifyUri: track.spotifyUri || '',
    spotifyUrl: track.spotifyUrl || '',
    imageUrl: track.imageUrl || '',
    album: track.album || '',
    durationMs: track.durationMs || 0,
  };
}

function shouldSkipTrack(track, avoidState) {
  const identity = trackIdentity(track);
  const urlIdentity = trackUrlIdentity(track);
  const artist = normalizeTrackText(track.artist);
  if (!identity) return { skip: false };

  if (avoidState.batchTrackKeys.has(identity) || (urlIdentity && avoidState.batchUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'same batch duplicate' };
  }
  if (avoidState.queueTrackKeys.has(identity) || (urlIdentity && avoidState.queueUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'already in current queue' };
  }
  if (avoidState.cooldownTrackKeys.has(identity) || (urlIdentity && avoidState.cooldownUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'played within 24h' };
  }
  if (artist && avoidState.recentArtistKeys.has(artist)) {
    return { skip: true, reason: `artist appeared in recent ${ARTIST_RECENT_WINDOW}` };
  }
  return { skip: false };
}

function createTrackAvoidState(extraQueue = []) {
  const queueTracks = [
    ...stationState.tracks,
    ...(Array.isArray(extraQueue) ? extraQueue : []),
  ];
  const queueTrackKeys = new Set(queueTracks.map(trackIdentity).filter(Boolean));
  const queueUrlKeys = new Set(queueTracks.map(trackUrlIdentity).filter(Boolean));
  const recent = recentPlays(50);
  const cutoff = Date.now() - TRACK_REPEAT_COOLDOWN_MS;
  const cooldownTracks = recent.filter(track => Number(track.played_at) >= cutoff);
  return {
    batchTrackKeys: new Set(),
    batchUrlKeys: new Set(),
    queueTrackKeys,
    queueUrlKeys,
    cooldownTrackKeys: new Set(cooldownTracks.map(trackIdentity).filter(Boolean)),
    cooldownUrlKeys: new Set(cooldownTracks.map(trackUrlIdentity).filter(Boolean)),
    recentArtistKeys: new Set(recent.slice(0, ARTIST_RECENT_WINDOW).map(track => normalizeTrackText(track.artist)).filter(Boolean)),
  };
}

function normalizeTracksForPrompt(tracks = []) {
  return tracks.map(track => ({
    query: track.query || trackLabel(track),
    title: track.title || track.query || '',
    artist: track.artist || '',
  }));
}

async function resolveRequestedTracks(requestedTracks, options = {}) {
  const tracks = [];
  const failedTracks = [];
  const avoidState = createTrackAvoidState(options.queue || []);
  const enforceAvoidance = options.enforceAvoidance !== false;

  const resolved = await mapWithConcurrency(requestedTracks, MUSIC_RESOLVE_CONCURRENCY, async (query, i) => {
    try {
      return { i, query, track: await getTrack(query) };
    } catch (err) {
      console.warn(`[音乐] ✗ ${i + 1}/${requestedTracks.length} 解析失败: ${query} | ${err.message}`);
      return { i, query, track: null };
    }
  });

  for (const item of resolved) {
    const { i, query, track } = item;
    if (track?.streamUrl || track?.spotifyUri) {
      const requested = parseRequestedTrack(query);
      if (!trackMatchesRequest(requested, track)) {
        failedTracks.push(`${query} (resolved mismatch: ${track.title}${track.artist ? ' — ' + track.artist : ''})`);
        console.log(`[音乐] ↷ ${i + 1}/${requestedTracks.length} 跳过错配: 请求 "${query}"，返回 "${track.title}${track.artist ? ' — ' + track.artist : ''}"`);
        continue;
      }
      const payloadTrack = payloadTrackFromResolved(query, requested, track);
      if (enforceAvoidance) {
        const skip = shouldSkipTrack(payloadTrack, avoidState);
        if (skip.skip) {
          failedTracks.push(`${query} (${skip.reason})`);
          console.log(`[音乐] ↷ ${i + 1}/${requestedTracks.length} 跳过重复: ${payloadTrack.title}${payloadTrack.artist ? ' — ' + payloadTrack.artist : ''} | ${skip.reason}`);
          continue;
        }
      }
      tracks.push(payloadTrack);
      avoidState.batchTrackKeys.add(trackIdentity(payloadTrack));
      const urlIdentity = trackUrlIdentity(payloadTrack);
      if (urlIdentity) avoidState.batchUrlKeys.add(urlIdentity);
      addPlay({ title: payloadTrack.title, artist: payloadTrack.artist, source_url: payloadTrack.streamUrl || payloadTrack.spotifyUri });
      console.log(`[音乐] ✓ ${i + 1}/${requestedTracks.length} 找到: ${payloadTrack.title}${payloadTrack.artist ? ' — ' + payloadTrack.artist : ''}`);
    } else {
      failedTracks.push(query);
      console.log(`[音乐] ✗ ${i + 1}/${requestedTracks.length} 未找到: ${query}`);
    }
  }
  return { tracks, failedTracks };
}

async function resolveFirstPlayableTrack(requestedTracks, options = {}) {
  const requested = Array.isArray(requestedTracks) ? requestedTracks.filter(Boolean) : [];
  const failedTracks = [];
  for (let i = 0; i < requested.length; i++) {
    const resolved = await resolveRequestedTracks([requested[i]], options);
    failedTracks.push(...resolved.failedTracks);
    if (resolved.tracks.length) {
      return {
        tracks: resolved.tracks,
        failedTracks,
        remainingPlay: requested.slice(i + 1),
      };
    }
  }
  return { tracks: [], failedTracks, remainingPlay: [] };
}

async function resolveDirectMusicRequest(request = {}) {
  const failedTracks = [];
  const rawQuery = String(request.query || request.title || request.artist || '').trim();
  if (!rawQuery) return { tracks: [], failedTracks: ['empty direct request'], requestType: 'unknown' };

  if (request.kind === 'artist') {
    const tracks = await resolveArtistRequest(request.artist || rawQuery);
    if (tracks.length) return { tracks, failedTracks, requestType: 'artist' };
    failedTracks.push(`${rawQuery} (artist not found)`);
    return { tracks: [], failedTracks, requestType: 'artist' };
  }

  if (request.kind === 'unknown') {
    const artistTracks = await resolveArtistRequest(rawQuery);
    if (artistTracks.length) return { tracks: artistTracks, failedTracks, requestType: 'artist' };
  }

  const trackQuery = request.kind === 'track' && request.title && request.artist
    ? `${request.title} - ${request.artist}`
    : rawQuery;
  const track = await getTrack(trackQuery);
  if (!track?.streamUrl && !track?.spotifyUri) {
    failedTracks.push(`${trackQuery} (track not found)`);
    return { tracks: [], failedTracks, requestType: 'track' };
  }

  const requested = parseRequestedTrack(trackQuery);
  if (request.kind === 'track' && !trackMatchesRequest(requested, track)) {
    failedTracks.push(`${trackQuery} (resolved mismatch: ${track.title}${track.artist ? ' — ' + track.artist : ''})`);
    console.log(`[点歌] ↷ 跳过错配: 请求 "${trackQuery}"，返回 "${track.title}${track.artist ? ' — ' + track.artist : ''}"`);
    return { tracks: [], failedTracks, requestType: 'track' };
  }
  const payloadTrack = payloadTrackFromResolved(trackQuery, requested, track);
  addPlay({ title: payloadTrack.title, artist: payloadTrack.artist, source_url: payloadTrack.streamUrl || payloadTrack.spotifyUri });
  console.log(`[点歌] ✓ 找到曲目: ${payloadTrack.title}${payloadTrack.artist ? ' — ' + payloadTrack.artist : ''}`);
  return { tracks: [payloadTrack], failedTracks, requestType: 'track' };
}

async function resolveArtistRequest(artist, options = {}) {
  const artistName = String(artist || '').trim();
  if (!artistName) return [];
  const resolved = await getArtistTracks(artistName, DIRECT_ARTIST_TRACK_COUNT, options);
  const tracks = resolved
    .filter(track => track?.streamUrl || track?.spotifyUri)
    .map(track => payloadTrackFromResolved(
      track.query || `${track.title || artistName} - ${artistName}`,
      { title: track.title || '', artist: artistName },
      track
    ));
  for (const track of tracks) {
    addPlay({ title: track.title, artist: track.artist, source_url: track.streamUrl || track.spotifyUri });
  }
  if (tracks.length) {
    console.log(`[点歌] ✓ 找到歌手 ${artistName}: ${tracks.map(track => `${track.title}${track.artist ? ' — ' + track.artist : ''}`).join(' / ')}`);
  }
  return tracks;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function enqueueJob(job) {
  const key = job.key || `${job.type}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (stationState.jobKeys.has(key)) {
    console.log(`[jobs] 跳过重复任务 ${key}`);
    return false;
  }
  stationState.jobKeys.add(key);
  const queuedJob = { ...job, key };
  const backgroundJob = ['bridge_generation', 'opening_generation'].includes(job.type);
  const queue = backgroundJob
    ? stationState.backgroundJobs
    : stationState.foregroundJobs;
  if (job.priority === 'high') queue.unshift(queuedJob);
  else queue.push(queuedJob);
  console.log(`[jobs] 入队 ${key}${backgroundJob ? ' (background)' : ''}`);
  if (backgroundJob) drainBackgroundJobs();
  else drainForegroundJobs();
  return true;
}

async function drainForegroundJobs() {
  if (stationState.foregroundWorkerRunning) return;
  stationState.foregroundWorkerRunning = true;
  while (stationState.foregroundJobs.length) {
    const job = stationState.foregroundJobs.shift();
    try {
      console.log(`[jobs] 开始 ${job.key}`);
      broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'started' });
      await runJob(job);
      console.log(`[jobs] 完成 ${job.key}`);
    } catch (err) {
      console.error(`[jobs] 失败 ${job.key}:`, err.message);
      broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'failed', error: err.message });
    } finally {
      stationState.jobKeys.delete(job.key);
    }
  }
  stationState.foregroundWorkerRunning = false;
}

async function drainBackgroundJobs() {
  if (stationState.backgroundWorkerRunning) return;
  stationState.backgroundWorkerRunning = true;
  while (stationState.backgroundJobs.length) {
    const job = stationState.backgroundJobs.shift();
    try {
      console.log(`[jobs:bg] 开始 ${job.key}`);
      broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'started' });
      await runJob(job);
      console.log(`[jobs:bg] 完成 ${job.key}`);
    } catch (err) {
      console.error(`[jobs:bg] 失败 ${job.key}:`, err.message);
      broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'failed', error: err.message });
    } finally {
      stationState.jobKeys.delete(job.key);
    }
  }
  stationState.backgroundWorkerRunning = false;
}

async function runJob(job) {
  if (job.type === 'program_start') return runProgramStartJob(job);
  if (job.type === 'opening_generation') return runOpeningGenerationJob(job);
  if (job.type === 'music_tail_resolve') return runMusicTailResolveJob(job);
  if (job.type === 'music_refill') return runMusicRefillJob(job);
  if (job.type === 'bridge_generation') return runBridgeGenerationJob(job);
  throw new Error(`Unknown job type: ${job.type}`);
}

function enqueueBridgeJobs({ programId, sessionTitle, tracks, startIndex = 0, previousTrack = null, previousIndex = null, djLanguage = 'en', hostMode = 'story' }) {
  if (previousTrack && tracks.length) {
    enqueueJob({
      type: 'bridge_generation',
      key: `bridge:${programId}:${previousIndex}:${startIndex}`,
      programId,
      sessionTitle,
      afterTrack: previousTrack,
      beforeTrack: tracks[0],
      afterTrackIndex: previousIndex,
      beforeTrackIndex: startIndex,
      programArc: stationState.programArc,
      djLanguage: normalizeDjLanguage(djLanguage),
      hostMode: normalizeHostMode(hostMode),
    });
  }
  for (let i = 1; i < tracks.length; i++) {
    enqueueJob({
      type: 'bridge_generation',
      key: `bridge:${programId}:${startIndex + i - 1}:${startIndex + i}`,
      programId,
      sessionTitle,
      afterTrack: tracks[i - 1],
      beforeTrack: tracks[i],
      afterTrackIndex: startIndex + i - 1,
      beforeTrackIndex: startIndex + i,
      programArc: stationState.programArc,
      djLanguage: normalizeDjLanguage(djLanguage),
      hostMode: normalizeHostMode(hostMode),
    });
  }
}

async function runProgramStartJob(job) {
  const timing = metricTimer('program_start');
  const programId = makeProgramId();
  let backupSignal = false;
  let result;
  let tracks = [];
  let failedTracks = [];
  let remainingPlay = [];
  if (job.musicRequest) {
    broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'phase', phase: 'resolve_audio' });
    const direct = await resolveDirectMusicRequest(job.musicRequest);
    tracks = direct.tracks;
    failedTracks = direct.failedTracks;
    timing.mark('direct_resolve_audio_ms');
    if (tracks.length) {
      result = {
        title: direct.requestType === 'artist'
          ? `${job.musicRequest.artist || job.musicRequest.query} Request`
          : `${tracks[0].title} Request`,
        play: tracks.map(trackLabel),
        segments: [],
        reason: `direct ${direct.requestType} request`,
      };
    }
  }

  if (!tracks.length) {
    broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'phase', phase: 'choose_tracks' });
    const prompt = buildProgramStartPrompt(job.input || 'Open the station.', job.queueState || '', {
      userIntent: job.userIntent,
      musicRequest: job.musicRequest,
      programArc: stationState.programArc,
      correctionContext: job.correctionContext,
      djLanguage: job.djLanguage,
      hostMode: job.hostMode,
    });
    try {
      result = await callClaude(prompt);
      timing.mark('choose_tracks_ms');
    } catch (err) {
      console.warn(`[program_start] LLM unavailable, using fallback set: ${err.message}`);
      broadcastUserSystemLog('warn', 'Starting fallback radio signal', { error: err.message });
      result = fallbackProgramStartResult(job, err.message);
      backupSignal = true;
      timing.mark('choose_tracks_fallback_ms');
    }

    broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'phase', phase: 'resolve_audio' });
    const resolved = await resolveFirstPlayableTrack(result.play || []);
    tracks = resolved.tracks;
    failedTracks = [...failedTracks, ...resolved.failedTracks];
    remainingPlay = resolved.remainingPlay;
    timing.mark('resolve_audio_ms');
  }
  if (!tracks.length) {
    console.warn('[program_start] No playable tracks from generated set; using fallback set.');
    const fallbackResult = fallbackProgramStartResult(job, 'no playable generated tracks');
    const fallbackResolved = await resolveFirstPlayableTrack(fallbackResult.play, { enforceAvoidance: false });
    if (fallbackResolved.tracks.length) {
      result = fallbackResult;
      tracks = fallbackResolved.tracks;
      failedTracks = [...failedTracks, ...fallbackResolved.failedTracks];
      remainingPlay = fallbackResolved.remainingPlay;
      backupSignal = true;
    }
    timing.mark('fallback_resolve_audio_ms');
  }

  if (tracks.length) {
    stationState.programId = programId;
    stationState.sessionTitle = result.title || '';
    stationState.tracks = tracks;
    stationState.programArc = createProgramArc({
      userInput: job.input || 'Open the station.',
      userIntent: job.userIntent,
      title: result.title || '',
      tracks,
      correctionContext: job.correctionContext,
    });
    stationState.lastCorrectionContext = job.correctionContext || null;
    nowPlaying = { title: tracks[0].title, artist: tracks[0].artist, startedAt: Date.now() };
    timing.mark('first_music_ready_ms');
    const leadInSegment = await buildOpeningLeadInSegment(job, result, tracks, stationState.programArc, timing);
    if (leadInSegment?.text) {
      addMessage('claudio', leadInSegment.text);
    }

    const payload = {
      type: 'program-start',
      programId,
      tracks,
      segments: leadInSegment ? [leadInSegment] : [],
      sessionTitle: result.title || '',
      stationName: STATION_NAME,
      programName: PROGRAM_NAME,
      programArc: stationState.programArc,
      failedTracks,
      reason: result.reason,
      signal: backupSignal ? 'backup' : 'live',
      openingPending: true,
      openingLeadIn: !!leadInSegment,
      openingContinuationWindowMs: OPENING_CONTINUATION_WINDOW_MS,
      metrics: timing.snapshot({ firstMusicReady: true }),
    };
    broadcast(payload);

    enqueueJob({
      type: 'opening_generation',
      key: `opening:${programId}`,
      priority: 'high',
      programId,
      result,
      tracks,
      failedTracks,
      input: job.input,
      userIntent: job.userIntent,
      musicRequest: job.musicRequest,
      correctionContext: job.correctionContext,
      programArc: stationState.programArc,
      openingLeadInText: leadInSegment?.text || '',
      djLanguage: job.djLanguage,
      hostMode: job.hostMode,
    });
    if (remainingPlay.length) {
      enqueueJob({
        type: 'music_tail_resolve',
        key: `tail:${programId}`,
        priority: 'high',
        programId,
        sessionTitle: result.title || '',
        play: remainingPlay,
        previousTrack: tracks[tracks.length - 1] || null,
        previousIndex: tracks.length - 1,
        djLanguage: job.djLanguage,
        hostMode: job.hostMode,
      });
    }
    enqueueBridgeJobs({ programId, sessionTitle: result.title || '', tracks, startIndex: 0, djLanguage: job.djLanguage, hostMode: job.hostMode });
    return payload;
  }

  broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'phase', phase: 'voice_open' });
  const coldOpenResult = result || fallbackProgramStartResult(job, 'no playable tracks');
  const segments = await synthesizeSegments(normalizeSegments(coldOpenResult, tracks, false, failedTracks));

  stationState.programId = programId;
  stationState.sessionTitle = coldOpenResult.title || '';
  stationState.tracks = tracks;
  stationState.programArc = createProgramArc({
    userInput: job.input || 'Open the station.',
    userIntent: job.userIntent,
    title: coldOpenResult.title || '',
    tracks,
    correctionContext: job.correctionContext,
  });
  stationState.lastCorrectionContext = job.correctionContext || null;
  if (tracks.length) nowPlaying = { title: tracks[0].title, artist: tracks[0].artist, startedAt: Date.now() };
  addMessage('claudio', segments.filter(s => s.text).map(s => s.text).join('\n\n'));

  const payload = {
    type: 'program-start',
    programId,
    tracks,
    segments,
    sessionTitle: coldOpenResult.title || '',
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    programArc: stationState.programArc,
    failedTracks,
    reason: coldOpenResult.reason,
    signal: backupSignal ? 'backup' : 'live',
    metrics: timing.snapshot({ firstMusicReady: false }),
  };
  broadcast(payload);

  return payload;
}

async function runOpeningGenerationJob(job) {
  const timing = metricTimer('opening_generation');
  const result = job.result || {};
  const tracks = Array.isArray(job.tracks) ? job.tracks : [];
  let coldOpenSegments = (result.segments || []).filter(segment => segment?.type === 'cold_open');
  let coldOpenReason = result.reason;

  broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'phase', phase: 'write_open' });
  const coldOpenPrompt = buildColdOpenForTracksPrompt({
    programTitle: result.title || '',
    tracks,
    userInput: job.input || 'Open the station.',
    userIntent: job.userIntent,
    musicRequest: job.musicRequest,
    programArc: job.programArc || stationState.programArc,
    correctionContext: job.correctionContext,
    leadInText: job.openingLeadInText || '',
    djLanguage: job.djLanguage,
    hostMode: job.hostMode,
  });
  try {
    const coldOpenScript = await callClaude(coldOpenPrompt);
    coldOpenSegments = Array.isArray(coldOpenScript.segments) ? coldOpenScript.segments : coldOpenSegments;
    coldOpenReason = coldOpenScript.reason || coldOpenReason;
    timing.mark('write_open_ms');
  } catch (err) {
    console.warn(`[opening_generation] Cold open LLM unavailable, using existing intro: ${err.message}`);
    coldOpenReason = coldOpenReason || `cold open fallback: ${err.message}`;
    timing.mark('write_open_fallback_ms');
  }

  if (isStaleProgramJob(job)) {
    console.log(`[opening_generation] skip stale opening for ${job.programId}`);
    return [];
  }

  broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'phase', phase: 'voice_open' });
  const coldOpenResult = {
    ...result,
    segments: coldOpenSegments.filter(segment =>
      !job.openingLeadInText ||
      String(segment?.text || '').trim() !== String(job.openingLeadInText || '').trim()
    ),
  };
  const segments = await synthesizeSegments(normalizeSegments(coldOpenResult, tracks, false, job.failedTracks || []));
  timing.mark('voice_open_ms');
  if (isStaleProgramJob(job)) {
    console.log(`[opening_generation] skip stale synthesized opening for ${job.programId}`);
    return [];
  }

  const liveOpeningSegments = segments.map((segment, index) => {
    if (segment.position !== 'before_track' || segment.trackIndex !== 0) return segment;
    const { trackIndex, ...rest } = segment;
    return {
      ...rest,
      id: `${segment.id}_live`,
      position: 'immediate',
      resetClockOnSpeak: index === 0,
    };
  });

  if (liveOpeningSegments.some(s => s.text)) {
    addMessage('claudio', liveOpeningSegments.filter(s => s.text).map(s => s.text).join('\n\n'));
  }
  broadcast({
    type: 'segment-ready',
    programId: job.programId || stationState.programId,
    segments: liveOpeningSegments,
    reason: coldOpenReason,
    opening: true,
    openingContinuation: !!job.openingLeadInText,
    continuationWindowMs: OPENING_CONTINUATION_WINDOW_MS,
    metrics: timing.snapshot(),
  });
  return liveOpeningSegments;
}

async function runMusicTailResolveJob(job) {
  const timing = metricTimer('music_tail_resolve');
  const programId = job.programId || stationState.programId || makeProgramId();
  if (isStaleProgramJob(job)) {
    console.log(`[music_tail_resolve] skip stale tail for ${job.programId}`);
    return { type: 'tracks-ready', programId, tracks: [], failedTracks: [], tail: true, stale: true, metrics: timing.snapshot() };
  }
  const startIndex = stationState.tracks.length;
  const previousTrack = job.previousTrack || stationState.tracks[startIndex - 1] || null;
  const previousIndex = Number.isInteger(job.previousIndex) ? job.previousIndex : startIndex - 1;
  const { tracks, failedTracks } = await resolveRequestedTracks(job.play || [], { queue: stationState.tracks });
  timing.mark('resolve_audio_ms');
  if (isStaleProgramJob(job)) {
    console.log(`[music_tail_resolve] skip stale resolved tail for ${job.programId}`);
    return { type: 'tracks-ready', programId, tracks: [], failedTracks, tail: true, stale: true, metrics: timing.snapshot() };
  }

  if (!tracks.length) {
    return { type: 'tracks-ready', programId, tracks: [], failedTracks, tail: true, metrics: timing.snapshot() };
  }

  stationState.programId = programId;
  stationState.sessionTitle = job.sessionTitle || stationState.sessionTitle || '';
  stationState.tracks = [...stationState.tracks, ...tracks];
  stationState.programArc = extendProgramArc(stationState.programArc, {
    tracksAdded: tracks.length,
    reason: 'resolved remaining startup tracks',
  });

  const payload = {
    type: 'tracks-ready',
    programId,
    tracks,
    startIndex,
    failedTracks,
    reason: 'resolved remaining startup tracks',
    programArc: stationState.programArc,
    tail: true,
    metrics: timing.snapshot(),
  };
  broadcast(payload);
  enqueueBridgeJobs({
    programId,
    sessionTitle: stationState.sessionTitle,
    tracks,
    startIndex,
    previousTrack,
    previousIndex,
    djLanguage: job.djLanguage,
    hostMode: job.hostMode,
  });
  return payload;
}

async function runMusicRefillJob(job) {
  const timing = metricTimer('music_refill');
  const programId = job.programId || stationState.programId || makeProgramId();
  if (isStaleProgramJob(job)) {
    console.log(`[music_refill] skip stale refill for ${job.programId}`);
    return { type: 'tracks-ready', programId, tracks: [], failedTracks: [], stale: true, metrics: timing.snapshot() };
  }
  const queue = normalizeTracksForPrompt(job.queue || stationState.tracks);
  const prompt = buildMusicRefillPrompt({
    programTitle: job.sessionTitle || stationState.sessionTitle,
    currentTrack: job.currentTrack,
    queue,
    count: job.count || REFILL_TRACK_COUNT,
    hostMode: job.hostMode,
    programArc: stationState.programArc,
  });
  const result = await callClaude(prompt);
  timing.mark('choose_tracks_ms');
  const { tracks, failedTracks } = await resolveRequestedTracks(result.play || [], { queue });
  timing.mark('resolve_audio_ms');
  if (isStaleProgramJob(job)) {
    console.log(`[music_refill] skip stale resolved refill for ${job.programId}`);
    return { type: 'tracks-ready', programId, tracks: [], failedTracks, stale: true, metrics: timing.snapshot() };
  }
  const startIndex = Number.isInteger(job.queueLength) ? job.queueLength : stationState.tracks.length;
  const previousTrack = job.previousTrack || stationState.tracks[stationState.tracks.length - 1] || null;
  const previousIndex = Number.isInteger(job.previousIndex) ? job.previousIndex : startIndex - 1;

  stationState.programId = programId;
  stationState.sessionTitle = job.sessionTitle || stationState.sessionTitle || result.title || '';
  stationState.tracks = [...stationState.tracks, ...tracks];
  stationState.programArc = extendProgramArc(stationState.programArc, {
    tracksAdded: tracks.length,
    reason: result.reason,
  });

  const payload = {
    type: 'tracks-ready',
    programId,
    tracks,
    startIndex,
    failedTracks,
    reason: result.reason,
    programArc: stationState.programArc,
    metrics: timing.snapshot(),
  };
  broadcast(payload);
  enqueueBridgeJobs({ programId, sessionTitle: stationState.sessionTitle, tracks, startIndex, previousTrack, previousIndex, djLanguage: job.djLanguage, hostMode: job.hostMode });
  return payload;
}

async function runBridgeGenerationJob(job) {
  const timing = metricTimer('bridge_generation');
  const prompt = buildBridgePrompt({
    programTitle: job.sessionTitle || stationState.sessionTitle,
    afterTrack: job.afterTrack,
    beforeTrack: job.beforeTrack,
    afterTrackIndex: job.afterTrackIndex,
    beforeTrackIndex: job.beforeTrackIndex,
    djLanguage: job.djLanguage,
    hostMode: job.hostMode,
    programArc: job.programArc || stationState.programArc,
  });
  const result = await callClaude(prompt);
  timing.mark('write_bridge_ms');
  if (isStaleProgramJob(job)) {
    console.log(`[bridge_generation] skip stale bridge for ${job.programId}`);
    return [];
  }
  let segments = await synthesizeSegments(normalizeSegments(
    result,
    new Array(Math.max(job.beforeTrackIndex + 1, 1)).fill(null),
    false,
    []
  ));
  if (isStaleProgramJob(job)) {
    console.log(`[bridge_generation] skip stale synthesized bridge for ${job.programId}`);
    return [];
  }
  segments = segments.filter(segment =>
    segment.position === 'between_tracks' &&
    segment.afterTrackIndex === job.afterTrackIndex &&
    segment.beforeTrackIndex === job.beforeTrackIndex
  );
  if (!segments.length) {
    segments = [normalizeSegment({
      type: 'silence',
      position: 'between_tracks',
      afterTrackIndex: job.afterTrackIndex,
      beforeTrackIndex: job.beforeTrackIndex,
      text: '',
    }, 0, job.beforeTrackIndex + 1)];
  }
  broadcast({
    type: 'segment-ready',
    programId: job.programId || stationState.programId,
    segments,
    metrics: timing.snapshot(),
  });
  if (segments.some(s => s.text)) addMessage('claudio', segments.filter(s => s.text).map(s => s.text).join('\n\n'));
  return segments;
}

// ── Radio engine — core segment runner ───────────────────────────────────────
async function runRadioSegment(userInput, intent = {}, skipHistory = false) {
  const src = intent.source || 'user';
  console.log(`\n[电台] ── 节目段开始 ── 来源: ${src}`);
  console.log(`[电台] 输入: "${userInput.slice(0, 80)}${userInput.length > 80 ? '…' : ''}"`);

  if (!skipHistory) addMessage('user', userInput);
  const prompt = buildPrompt(userInput, nowPlaying ? JSON.stringify(nowPlaying) : '', {
    mode: intent.mode,
    userIntent: intent.userIntent,
    musicRequest: intent.musicRequest,
    programArc: stationState.programArc,
    correctionContext: intent.correctionContext,
    djLanguage: intent.djLanguage,
    hostMode: intent.hostMode,
  });
  const speechOnly = intent.mode === 'speech-only';
  const result = await callClaude(prompt);

  console.log(`[电台] Claude 回复 → 节目「${result.title || '无标题'}」| 请求曲目 ${result.play?.length || 0} 首`);
  if (result.segments?.length) console.log(`[电台] 脚本段落: ${result.segments.length}`);
  if (result.say) console.log(`[电台] 兼容旁白: "${result.say.slice(0, 100)}${result.say.length > 100 ? '…' : ''}"`);

  const requestedTracks = speechOnly ? [] : (result.play || []);
  const { tracks, failedTracks } = await resolveRequestedTracks(requestedTracks);

  const segments = await synthesizeSegments(normalizeSegments(result, tracks, speechOnly, failedTracks));
  applyLegacyTrackIntrosFromSegments(tracks, segments);
  const firstPlayableSegment = segments.find(s => s.ttsUrl && s.text && s.type !== 'silence');
  const announcement = buildAnnouncement({ ...result, segments }, tracks, failedTracks, speechOnly);
  const spokenSummary = segments.filter(s => s.text).map(s => s.text).join('\n\n');
  addMessage('claudio', spokenSummary || announcement || result.say || '');
  const ttsUrl = firstPlayableSegment?.ttsUrl || null;

  if (tracks.length) {
    nowPlaying = { title: tracks[0].title, artist: tracks[0].artist, startedAt: Date.now() };
  }

  const payload = {
    type: 'now-playing',
    ttsUrl,
    tracks,
    segments,
    sessionTitle: result.title || '',
    transcript: announcement,
    djNote: result.say,
    reason: result.reason,
    mode: speechOnly ? 'speech-only' : 'music',
    status: speechOnly ? 'speaking' : (tracks.length ? 'queued' : 'speaking'),
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    programArc: stationState.programArc,
    trigger: intent.source || 'user',
    failedTracks,
  };

  broadcast(payload);
  console.log(`[电台] ── 广播完成 ── 入队 ${tracks.length} 首 | 失败 ${failedTracks.length} 首\n`);
  return payload;
}

async function handleClaudeRequest(userInput, res, intent = {}, skipHistory = false) {
  try {
    const payload = await runRadioSegment(userInput, intent, skipHistory);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    console.error('[chat]', err);
    res.status(500).json({ error: err.message });
  }
}

// ── HTTP Routes ──────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, autoRefill, djLanguage, hostMode } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const intent = route(message);
  intent.source = autoRefill ? 'autoRefill' : 'user';
  intent.djLanguage = normalizeDjLanguage(djLanguage);
  intent.hostMode = normalizeHostMode(hostMode);
  const personalizationSignals = captureUserSignal(message, intent, nowPlaying);
  if (personalizationSignals?.length) {
    intent.personalizationSignals = personalizationSignals;
    console.log(`[dj-memory] ${personalizationSignals.join(', ')}`);
  }

  if (intent.action === 'next') {
    broadcast({ type: 'control', action: 'next' });
    return res.json({ action: 'next' });
  }
  if (intent.action === 'pause') {
    broadcast({ type: 'control', action: 'pause' });
    return res.json({ action: 'pause' });
  }
  if (intent.action === 'resume') {
    broadcast({ type: 'control', action: 'resume' });
    return res.json({ action: 'resume' });
  }
  if (intent.action === 'volume') {
    broadcast({ type: 'control', action: 'volume', delta: intent.delta });
    return res.json({ action: 'volume', delta: intent.delta });
  }

  if (intent.userIntent === 'correction' && !autoRefill) {
    const correctionContext = buildCorrectionContext(message, {
      nowPlaying,
      tracks: stationState.tracks,
      lastMusicIntent: stationState.lastMusicIntent,
    });
    const canRecover = correctionContext.target || correctionContext.rejectedTrack || correctionContext.lastMusicIntent;
    if (canRecover) {
      stationState.lastCorrectionContext = correctionContext;
      const accepted = enqueueJob({
        type: 'program_start',
        key: `program_start:correction:${Date.now()}`,
        input: intent.message,
        source: 'user',
        userIntent: intent.userIntent,
        djLanguage: intent.djLanguage,
        hostMode: intent.hostMode,
        musicRequest: null,
        correctionContext,
      });
      return res.json({ queued: accepted, jobType: 'program_start', correction: true });
    }
  }

  if (intent.mode !== 'speech-only') {
    stationState.lastMusicIntent = {
      message: intent.message,
      userIntent: intent.userIntent,
      musicRequest: intent.musicRequest || null,
      at: Date.now(),
    };
    enqueueJob({
      type: 'program_start',
      key: `program_start:${Date.now()}`,
      input: intent.message,
      source: autoRefill ? 'autoRefill' : 'user',
      userIntent: intent.userIntent,
      djLanguage: intent.djLanguage,
      hostMode: intent.hostMode,
      musicRequest: intent.musicRequest || null,
      correctionContext: null,
    });
    return res.json({ queued: true, jobType: 'program_start' });
  }

  await handleClaudeRequest(intent.message, res, intent, !!autoRefill);
});

app.post('/api/radio/refill', (req, res) => {
  const {
    programId,
    sessionTitle,
    currentTrack,
    previousTrack,
    previousIndex,
    queue = [],
    queueLength,
    djLanguage,
    hostMode,
  } = req.body || {};
  const effectiveProgramId = programId || stationState.programId || makeProgramId();
  const effectiveQueueLength = Number.isInteger(queueLength) ? queueLength : Array.isArray(queue) ? queue.length : stationState.tracks.length;
  const key = `music_refill:${effectiveProgramId}`;
  const accepted = enqueueJob({
    type: 'music_refill',
    key,
    programId: effectiveProgramId,
    sessionTitle: sessionTitle || stationState.sessionTitle,
    currentTrack,
    previousTrack,
    previousIndex,
    queue: Array.isArray(queue) ? queue : [],
    queueLength: effectiveQueueLength,
    count: REFILL_TRACK_COUNT,
    djLanguage: normalizeDjLanguage(djLanguage),
    hostMode: normalizeHostMode(hostMode),
  });
  res.json({ queued: accepted, jobType: 'music_refill', programId: effectiveProgramId });
});

app.get('/api/now', (req, res) => {
  res.json(nowPlaying || { playing: false });
});

app.get('/api/program-arc', (req, res) => {
  res.json(stationState.programArc || { active: false });
});

app.get('/api/environment', async (req, res) => {
  res.json(await environmentSnapshot());
});

app.post('/api/environment', async (req, res) => {
  updateEnvironment(req.body || {});
  res.json(await environmentSnapshot());
});

app.post('/api/next', async (req, res) => {
  broadcast({ type: 'control', action: 'next' });
  res.json({ action: 'next' });
});

app.get('/api/taste', (req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, 'user/taste.md'), 'utf-8');
    res.type('text/plain').send(content);
  } catch {
    res.status(404).json({ error: 'taste.md not found' });
  }
});

app.get('/api/dj-memory', (req, res) => {
  res.json(loadDjMemory());
});

app.get('/api/plan/today', (req, res) => {
  const plan = getPref('today_plan');
  res.json(plan || { message: '今日计划尚未生成' });
});

app.get('/auth/spotify', (req, res) => {
  const { clientId } = spotifyCredentials();
  if (!clientId) return res.status(500).send('SPOTIFY_CLIENT_ID not set');
  const state = cryptoRandomState();
  writeSpotifyState(state);
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', spotifyRedirectUri(req));
  url.searchParams.set('scope', SPOTIFY_SCOPES);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/auth/spotify/callback', async (req, res) => {
  const spotifyError = typeof req.query.error === 'string' ? req.query.error : '';
  const spotifyErrorDescription = typeof req.query.error_description === 'string' ? req.query.error_description : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (spotifyError) {
    return res.status(400).send(`Spotify authorization failed: ${spotifyErrorDescription || spotifyError}`);
  }
  if (!code) return res.status(400).send('Missing Spotify authorization code. Start from /auth/spotify instead of opening this callback URL directly.');
  if (!consumeSpotifyState(state)) return res.status(400).send('Invalid or expired Spotify authorization state');

  try {
    const token = await requestSpotifyToken({
      grant_type: 'authorization_code',
      code,
    }, req);
    writeSpotifyToken({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type || 'Bearer',
      scope: token.scope || SPOTIFY_SCOPES,
      expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
      updated_at: new Date().toISOString(),
    });
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Spotify connected</title><p>Spotify connected. You can return to <a href="/">Claudio FM</a>.</p>');
  } catch (err) {
    console.error('[spotify-auth]', err.message);
    res.status(500).send(err.message);
  }
});

app.get('/api/spotify/status', async (req, res) => {
  try {
    const token = await getSpotifyUserToken(req);
    res.json({ authenticated: !!token?.access_token, authUrl: '/auth/spotify' });
  } catch (err) {
    res.status(500).json({ authenticated: false, authUrl: '/auth/spotify', error: err.message });
  }
});

app.get('/api/spotify/token', async (req, res) => {
  try {
    const token = await getSpotifyUserToken(req);
    if (!token?.access_token) return res.status(401).json({ error: 'spotify_auth_required', authUrl: '/auth/spotify' });
    res.json({ access_token: token.access_token, expires_at: token.expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message, authUrl: '/auth/spotify' });
  }
});

app.post('/api/spotify/play', async (req, res) => {
  try {
    const token = await getSpotifyUserToken(req);
    if (!token?.access_token) return res.status(401).json({ error: 'spotify_auth_required', authUrl: '/auth/spotify' });

    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
    const uri = typeof req.body?.uri === 'string' ? req.body.uri : '';
    if (!deviceId || !uri) return res.status(400).json({ error: 'deviceId and uri required' });

    const url = new URL('https://api.spotify.com/v1/me/player/play');
    url.searchParams.set('device_id', deviceId);
    const apiRes = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [uri] }),
    });
    const text = await apiRes.text().catch(() => '');
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ error: text || `Spotify play failed: ${apiRes.status}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tts/caller', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 800) return res.status(400).json({ error: 'text too long' });

  try {
    const f = await synthesize(text, callerTtsOptions());
    res.json({ ttsUrl: '/api/tts/' + path.basename(f) });
  } catch (err) {
    console.error('[caller-tts]', err);
    const provider = process.env.CALLER_TTS_PROVIDER || process.env.TTS_PROVIDER || 'volcengine';
    if (provider === 'kokoro' && /fetch failed|ECONNREFUSED|failed/i.test(err.message)) {
      broadcastUserSystemLog('error', `tts not started: Kokoro unreachable at ${kokoroBaseUrl()}`, {
        error: err.message,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// Serve cached TTS files
app.get('/api/tts/:filename', (req, res) => {
  if (!TTS_CACHE_FILENAME.test(req.params.filename)) return res.status(404).end();
  const file = path.resolve(TTS_CACHE_DIR, req.params.filename);
  if (!file.startsWith(`${TTS_CACHE_DIR}${path.sep}`)) return res.status(404).end();
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

function cryptoRandomState() {
  return crypto.randomBytes(24).toString('base64url');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
scheduler.init(broadcast, runRadioSegment);

server.listen(PORT, HOST, () => {
  console.log(`\n[电台] Claudio FM 启动 → http://${HOST}:${PORT}`);
  console.log(`[电台] 等待调度器或用户触发…\n`);
});
