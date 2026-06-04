const ytDlp = require('./music-yt-dlp');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 200;

let cachedToken = null;
const lookupCache = new Map();

function envFlag(name, defaultEnabled = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultEnabled;
  return value === '1' || value.toLowerCase() === 'true';
}

function cacheTtlMs() {
  return Math.max(0, Number(process.env.MUSIC_LOOKUP_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS));
}

function negativeCacheTtlMs() {
  return Math.max(0, Number(process.env.MUSIC_NEGATIVE_CACHE_TTL_MS || DEFAULT_NEGATIVE_CACHE_TTL_MS));
}

function cacheMaxEntries() {
  return Math.max(0, Number(process.env.MUSIC_LOOKUP_CACHE_MAX_ENTRIES || DEFAULT_CACHE_MAX_ENTRIES));
}

function cloneCacheValue(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function pruneLookupCache(now = Date.now()) {
  for (const [key, entry] of lookupCache.entries()) {
    if (!entry || entry.expiresAt <= now) lookupCache.delete(key);
  }
  const maxEntries = cacheMaxEntries();
  if (!maxEntries) {
    lookupCache.clear();
    return;
  }
  while (lookupCache.size > maxEntries) {
    const oldestKey = lookupCache.keys().next().value;
    if (!oldestKey) break;
    lookupCache.delete(oldestKey);
  }
}

function setCacheEntry(key, entry) {
  lookupCache.delete(key);
  lookupCache.set(key, entry);
  pruneLookupCache();
}

async function cachedLookup(key, resolver) {
  const now = Date.now();
  pruneLookupCache(now);
  const hit = lookupCache.get(key);
  if (hit && hit.expiresAt > now) {
    lookupCache.delete(key);
    lookupCache.set(key, hit);
    if (hit.promise) return cloneCacheValue(await hit.promise);
    console.log(`[spotify-cache] hit ${key}`);
    return cloneCacheValue(hit.value);
  }

  const promise = Promise.resolve().then(resolver);
  setCacheEntry(key, { promise, expiresAt: now + cacheTtlMs() });
  try {
    const value = await promise;
    const ttl = value ? cacheTtlMs() : negativeCacheTtlMs();
    if (ttl > 0) {
      setCacheEntry(key, { value: cloneCacheValue(value), expiresAt: Date.now() + ttl });
    } else {
      lookupCache.delete(key);
    }
    return cloneCacheValue(value);
  } catch (err) {
    lookupCache.delete(key);
    throw err;
  }
}

function fallbackProvider() {
  return String(process.env.MUSIC_FALLBACK_PROVIDER || 'none').trim().toLowerCase();
}

function spotifyFastStartEnabled() {
  return envFlag('SPOTIFY_FAST_START', true);
}

function splitQuery(query) {
  const parts = String(query || '').split(/\s+-\s+/);
  return {
    title: parts[0]?.trim() || String(query || '').trim(),
    artist: parts.slice(1).join(' - ').trim(),
  };
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[這麼們個愛聽與夢風雲臺台裡裏為無後會國樂歡聲恆當讓開關過還點對萬]/g, char => ({
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
      '恆': '恒',
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

function withTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function getCredentials() {
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  };
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.accessToken;
  }

  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set');
  }

  const timeout = withTimeout();
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: timeout.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Spotify token error ${res.status}: ${body.error_description || body.error || 'unknown error'}`);
    }

    cachedToken = {
      accessToken: body.access_token,
      expiresAt: now + Number(body.expires_in || 3600) * 1000,
    };
    return cachedToken.accessToken;
  } finally {
    timeout.clear();
  }
}

async function spotifyGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const timeout = withTimeout();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeout.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Spotify API error ${res.status}: ${body.error?.message || 'unknown error'}`);
    }
    return body;
  } finally {
    timeout.clear();
  }
}

function normalizeTrack(raw, query) {
  if (!raw) return null;
  const image = raw.album?.images?.[0]?.url || '';
  const artists = Array.isArray(raw.artists) ? raw.artists.map(a => a.name).filter(Boolean) : [];
  return {
    id: raw.id,
    spotifyId: raw.id,
    spotifyUri: raw.uri,
    spotifyUrl: raw.external_urls?.spotify || '',
    title: raw.name || query,
    artist: artists.join(', '),
    album: raw.album?.name || '',
    imageUrl: image,
    durationMs: raw.duration_ms || 0,
    previewUrl: raw.preview_url || '',
    query,
    source: 'spotify',
  };
}

async function searchSpotify(query) {
  const market = process.env.SPOTIFY_MARKET || 'US';
  const cacheKey = `search:${market}:${normalizeSearchText(query)}`;
  return cachedLookup(cacheKey, () => searchSpotifyUncached(query, market));
}

async function searchSpotifyUncached(query, market) {
  const { title, artist } = splitQuery(query);
  const searches = [];

  if (title && artist) searches.push(`track:${title} artist:${artist}`);
  searches.push(query);

  for (const q of searches) {
    const data = await spotifyGet('/search', {
      q,
      type: 'track',
      limit: 5,
      market,
      include_external: 'audio',
    });
    const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
    const track = chooseBestTrack(items, { title, artist, query });
    if (track) return track;
  }

  return null;
}

function chooseBestTrack(items, request) {
  if (!items.length) return null;
  const requestedTitle = normalizeSearchText(request.title || request.query);
  const requestedArtist = normalizeSearchText(request.artist);
  let best = null;
  let bestScore = -1;

  for (const item of items) {
    const track = normalizeTrack(item, request.query);
    if (!track) continue;
    const title = normalizeSearchText(track.title);
    const artists = normalizeSearchText(track.artist);
    const titleScore = titleMatchScore(requestedTitle, title);
    const artistScore = artistMatchScore(requestedArtist, artists);
    let score = titleScore + artistScore;
    if (track.spotifyUri) score += 1;
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }

  const requiredScore = requestedArtist ? 80 : 55;
  return bestScore >= requiredScore ? best : null;
}

function titleMatchScore(requestedTitle, title) {
  if (!requestedTitle || !title) return 0;
  if (title === requestedTitle) return 120;
  if (phraseContains(title, requestedTitle)) return 95;
  if (title.length >= 2 && phraseContains(requestedTitle, title)) return 80;
  const requestedTokens = requestedTitle.split(' ').filter(Boolean);
  const titleTokens = title.split(' ').filter(Boolean);
  if (!requestedTokens.length || !titleTokens.length) return 0;
  const overlap = requestedTokens.filter(token => titleTokens.includes(token)).length;
  const ratio = overlap / Math.max(requestedTokens.length, 1);
  if (ratio >= 0.8) return 70;
  if (ratio >= 0.5) return 45;
  return 0;
}

function phraseContains(text, phrase) {
  if (!text || !phrase) return false;
  if (hasCjk(phrase) || hasCjk(text)) return text.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(text);
}

function hasCjk(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(String(value || ''));
}

function artistMatchScore(requestedArtist, artists) {
  if (!requestedArtist) return 0;
  if (!artists) return 0;
  if (artists === requestedArtist) return 90;
  if (artists.includes(requestedArtist) || requestedArtist.includes(artists)) return 80;
  return 0;
}

async function getArtistTracks(query, count = 3) {
  const market = process.env.SPOTIFY_MARKET || 'US';
  const cacheKey = [
    'artist',
    market,
    count,
    fallbackProvider(),
    spotifyFastStartEnabled() ? 'fast' : 'stream',
    envFlag('SPOTIFY_ALLOW_PREVIEW') ? 'preview' : 'no-preview',
    normalizeSearchText(query),
  ].join(':');
  return cachedLookup(cacheKey, () => getArtistTracksUncached(query, count, market));
}

async function getArtistTracksUncached(query, count, market) {
  try {
    const artistName = String(query || '').trim();
    const normalizedArtist = normalizeSearchText(artistName);
    if (!normalizedArtist) return [];
    const data = await spotifyGet('/search', {
      q: artistName,
      type: 'track',
      limit: 10,
      market,
      include_external: 'audio',
    });
    const items = (Array.isArray(data?.tracks?.items) ? data.tracks.items : [])
      .filter(item => {
        const artists = Array.isArray(item?.artists) ? item.artists.map(a => a.name).join(' ') : '';
        return normalizeSearchText(artists).includes(normalizedArtist);
      });
    const tracks = [];
    for (const item of items) {
      const track = normalizeTrack(item, `${item?.name || ''} - ${artistName}`);
      if (!track) continue;
      const streamUrl = await resolveStreamUrl(track);
      tracks.push({
        ...track,
        artist: track.artist || artistName,
        query: `${track.title} - ${artistName}`,
        streamUrl: streamUrl || '',
        lyrics: null,
      });
      if (tracks.length >= count) break;
    }
    return tracks;
  } catch (err) {
    console.warn('[spotify] artist lookup failed:', err.message);
    return [];
  }
}

async function resolveStreamUrl(track) {
  const provider = fallbackProvider();
  if (spotifyFastStartEnabled() && track.spotifyUri) {
    return null;
  }

  if (provider === 'yt-dlp') {
    const lookup = `${track.title}${track.artist ? ' - ' + track.artist : ''}`;
    const streamUrl = await ytDlp.getStreamUrl(lookup);
    if (streamUrl) return streamUrl;
  }

  if (envFlag('SPOTIFY_ALLOW_PREVIEW') && track.previewUrl) {
    return track.previewUrl;
  }

  return null;
}

async function getTrack(query) {
  const market = process.env.SPOTIFY_MARKET || 'US';
  const cacheKey = [
    'track',
    market,
    fallbackProvider(),
    spotifyFastStartEnabled() ? 'fast' : 'stream',
    envFlag('SPOTIFY_ALLOW_PREVIEW') ? 'preview' : 'no-preview',
    normalizeSearchText(query),
  ].join(':');
  return cachedLookup(cacheKey, () => getTrackUncached(query));
}

async function getTrackUncached(query) {
  try {
    const track = await searchSpotify(query);
    if (!track) return null;

    const streamUrl = await resolveStreamUrl(track);
    if (!streamUrl) {
      console.log(`[spotify] using Web Playback URI: ${track.title} - ${track.artist || 'unknown'}`);
    }

    return {
      ...track,
      streamUrl: streamUrl || '',
      lyrics: null,
    };
  } catch (err) {
    console.warn('[spotify] search failed:', err.message);
    return null;
  }
}

module.exports = {
  getAccessToken,
  getTrack,
  getArtistTracks,
  searchSpotify,
  _test: {
    chooseBestTrack,
    normalizeSearchText,
    cacheMaxEntries,
    pruneLookupCache,
    lookupCache,
  },
};
