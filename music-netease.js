const DEFAULT_TIMEOUT_MS = 8000;
const { getNeteaseConfig, redactSensitiveText } = require('./netease-session');

function getConfig() {
  const { baseUrl, cookie } = getNeteaseConfig();
  return { baseUrl, cookie };
}

function withTimeout(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function requestJson(path, params = {}) {
  const { baseUrl, cookie } = getConfig();
  if (!baseUrl) return null;

  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const timeout = withTimeout();
  try {
    const res = await fetch(url, {
      headers: cookie ? { Cookie: cookie } : undefined,
      signal: timeout.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    timeout.clear();
  }
}

function normalizeSong(raw) {
  if (!raw) return null;

  const artists = raw.artists || raw.ar || [];
  return {
    id: raw.id,
    title: raw.name,
    artist: artists.map(a => a.name).filter(Boolean).join(', '),
  };
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

function significantTokens(value) {
  return normalizeSearchText(value)
    .split(' ')
    .filter(token => token.length > 1 || hasCjk(token));
}

function hasCjk(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(String(value || ''));
}

function phraseContains(text, phrase) {
  if (!text || !phrase) return false;
  if (hasCjk(phrase) || hasCjk(text)) return text.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(text);
}

function textMatchScore(requested, candidate) {
  if (!requested || !candidate) return 0;
  if (requested === candidate) return 120;
  if (phraseContains(candidate, requested)) return 95;
  if (candidate.length >= 2 && phraseContains(requested, candidate)) return 80;
  const requestedTokens = significantTokens(requested);
  const candidateTokens = significantTokens(candidate);
  if (!requestedTokens.length || !candidateTokens.length) return 0;
  const overlap = requestedTokens.filter(token =>
    candidateTokens.some(candidate => tokenMatches(token, candidate))
  ).length;
  const ratio = overlap / requestedTokens.length;
  if (ratio >= 0.8) return 70;
  if (ratio >= 0.5) return 45;
  return 0;
}

function tokenMatches(requested, candidate) {
  if (!requested || !candidate) return false;
  if (requested === candidate) return true;
  if (hasCjk(requested) || hasCjk(candidate)) return candidate.includes(requested) || requested.includes(candidate);
  return requested.length >= 4 && candidate.startsWith(requested);
}

function chooseBestSong(songs, query) {
  const { title, artist } = splitQuery(query);
  const requestedTitle = normalizeSearchText(title || query);
  const requestedArtist = normalizeSearchText(artist);
  let best = null;
  let bestScore = -1;

  for (const raw of songs || []) {
    const song = normalizeSong(raw);
    if (!song?.title) continue;
    const titleScore = textMatchScore(requestedTitle, normalizeSearchText(song.title));
    const artistScore = requestedArtist
      ? textMatchScore(requestedArtist, normalizeSearchText(song.artist))
      : 0;
    const score = titleScore + artistScore;
    if (score > bestScore) {
      best = song;
      bestScore = score;
    }
  }

  const requiredScore = requestedArtist ? 85 : 60;
  return bestScore >= requiredScore ? best : null;
}

async function searchSong(query) {
  try {
    const data = await requestJson('/search', {
      keywords: query,
      type: 1,
      limit: 10,
    });
    return chooseBestSong(data?.result?.songs || [], query);
  } catch (err) {
    console.warn('[netease] search failed:', redactSensitiveText(err.message));
    return null;
  }
}

async function getLyrics(id) {
  if (!id) return null;

  try {
    const data = await requestJson('/lyric', { id });
    const lrc = data?.lrc?.lyric || '';
    const translated = data?.tlyric?.lyric || '';
    if (!lrc && !translated) return null;
    return { lrc, translated };
  } catch (err) {
    console.warn('[netease] lyric failed:', redactSensitiveText(err.message));
    return null;
  }
}

async function getTrack(query) {
  const { baseUrl } = getConfig();
  if (!baseUrl) return null;

  const song = await searchSong(query);
  if (!song?.id) return null;

  try {
    const data = await requestJson('/song/url/v1', {
      id: song.id,
      level: process.env.NETEASE_LEVEL || 'standard',
    });
    const item = data?.data?.[0];
    const streamUrl = item?.url;
    if (!streamUrl) {
      console.warn(`[netease] no playable url: ${song.title} - ${song.artist || 'unknown'}`);
      return null;
    }

    return {
      ...song,
      query,
      streamUrl,
      lyrics: await getLyrics(song.id),
    };
  } catch (err) {
    console.warn('[netease] track failed:', redactSensitiveText(err.message));
    return null;
  }
}

module.exports = { getTrack, searchSong, getLyrics };
