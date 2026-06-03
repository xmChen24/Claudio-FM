const ytDlp = require('./music-yt-dlp');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const DEFAULT_TIMEOUT_MS = 10000;

let cachedToken = null;

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
  const { title, artist } = splitQuery(query);
  const market = process.env.SPOTIFY_MARKET || 'US';
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
    let score = 0;
    if (requestedTitle && title === requestedTitle) score += 100;
    else if (requestedTitle && title.includes(requestedTitle)) score += 60;
    else if (requestedTitle && requestedTitle.includes(title)) score += 40;
    if (requestedArtist && artists.includes(requestedArtist)) score += 80;
    if (!requestedArtist && requestedTitle && title.startsWith(requestedTitle)) score += 10;
    if (track.spotifyUri) score += 1;
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }

  return best || normalizeTrack(items[0], request.query);
}

async function getArtistTracks(query, count = 3) {
  try {
    const market = process.env.SPOTIFY_MARKET || 'US';
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
  const fallbackProvider = process.env.MUSIC_FALLBACK_PROVIDER || 'yt-dlp';

  if (process.env.SPOTIFY_FAST_START === '1' && track.spotifyUri) {
    return null;
  }

  if (fallbackProvider === 'yt-dlp') {
    const lookup = `${track.title}${track.artist ? ' - ' + track.artist : ''}`;
    const streamUrl = await ytDlp.getStreamUrl(lookup);
    if (streamUrl) return streamUrl;
  }

  if (process.env.SPOTIFY_ALLOW_PREVIEW === '1' && track.previewUrl) {
    return track.previewUrl;
  }

  return null;
}

async function getTrack(query) {
  try {
    const track = await searchSpotify(query);
    if (!track) return null;

    const streamUrl = await resolveStreamUrl(track);
    if (!streamUrl) {
      console.warn(`[spotify] no fallback stream; using Spotify Web Playback URI: ${track.title} - ${track.artist || 'unknown'}`);
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
};
