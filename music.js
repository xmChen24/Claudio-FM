const spotify = require('./music-spotify');
const ytDlp = require('./music-yt-dlp');

function fallbackProvider() {
  return String(process.env.MUSIC_FALLBACK_PROVIDER || 'none').trim().toLowerCase();
}

function ytDlpFallbackEnabled() {
  return fallbackProvider() === 'yt-dlp';
}

function normalizeProvider(value) {
  return 'spotify';
}

function selectedProvider(options = {}) {
  return normalizeProvider(String(options.provider || process.env.MUSIC_PROVIDER || 'spotify').trim().toLowerCase());
}

async function getTrack(query, options = {}) {
  const provider = selectedProvider(options);
  console.log(`[音乐] 搜索: "${query}" (来源: ${provider})`);

  if (provider === 'spotify') {
    const spotifyTrack = await spotify.getTrack(query);
    if (spotifyTrack) {
      console.log(`[音乐] Spotify 找到: ${spotifyTrack.title || query}${spotifyTrack.artist ? ' — ' + spotifyTrack.artist : ''}`);
      return spotifyTrack;
    }
    if (provider === 'spotify') {
      console.log(ytDlpFallbackEnabled()
        ? `[音乐] Spotify 未找到可播版本，尝试 yt-dlp…`
        : `[音乐] Spotify 未找到可播版本，已关闭 yt-dlp fallback`);
      if (!ytDlpFallbackEnabled()) return null;
    }
  }

  if (ytDlpFallbackEnabled()) {
    const ytTrack = await ytDlp.getTrack(query);
    if (ytTrack) {
      console.log(`[音乐] yt-dlp 找到: ${ytTrack.title || query}`);
    } else {
      console.log(`[音乐] yt-dlp 也未找到: "${query}"`);
    }
    return ytTrack;
  }

  console.log(`[音乐] 未找到且未启用 yt-dlp fallback: "${query}"`);
  return null;
}

async function getArtistTracks(query, count = 3, options = {}) {
  const provider = selectedProvider(options);
  console.log(`[音乐] 搜索歌手: "${query}" (来源: ${provider})`);

  if (provider === 'spotify') {
    const tracks = await spotify.getArtistTracks(query, count, options);
    if (tracks.length) {
      console.log(`[音乐] Spotify 歌手找到: ${query} → ${tracks.map(track => track.title).join(', ')}`);
      return tracks;
    }
  }

  return [];
}

module.exports = { getTrack, getArtistTracks };
