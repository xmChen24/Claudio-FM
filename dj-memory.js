const fs = require('fs');
const path = require('path');

const MEMORY_PATH = path.join(__dirname, 'user/dj-memory.json');
const MAX_LIST_ITEMS = 30;
const MAX_RECENT_SIGNALS = 20;
const MAX_EPISODES = 40;
const MAX_PROMPT_EPISODES = 8;
const SESSION_SIGNAL_TTL_MS = 1000 * 60 * 60 * 6;

const DEFAULT_MEMORY = {
  version: 1,
  updatedAt: null,
  preferences: {
    likedArtists: [],
    dislikedArtists: [],
    likedTracks: [],
    dislikedTracks: [],
    avoidedArtists: [],
    hostModeHints: [],
    savedVibes: [],
  },
  session: {
    talkLevel: null,
    mood: null,
    activity: null,
    recentSignals: [],
  },
  relationship: {
    episodes: [],
  },
};

function loadDjMemory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
    return mergeMemory(parsed);
  } catch {
    return mergeMemory({});
  }
}

function saveDjMemory(memory) {
  const next = mergeMemory(memory);
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function formatDjMemoryForPrompt() {
  const memory = loadDjMemory();
  const prefs = memory.preferences;
  const session = recentSession(memory.session);
  const lines = [];

  if (prefs.likedArtists.length) lines.push(`Liked artists: ${prefs.likedArtists.join(', ')}`);
  if (prefs.dislikedArtists.length) lines.push(`Disliked artists: ${prefs.dislikedArtists.join(', ')}`);
  if (prefs.avoidedArtists.length) lines.push(`Avoided artists: ${prefs.avoidedArtists.join(', ')}`);
  if (prefs.likedTracks.length) lines.push(`Liked tracks: ${prefs.likedTracks.map(trackLabel).join('; ')}`);
  if (prefs.dislikedTracks.length) lines.push(`Disliked tracks: ${prefs.dislikedTracks.map(trackLabel).join('; ')}`);
  if (prefs.hostModeHints.length) lines.push(`Host style hints: ${prefs.hostModeHints.join('; ')}`);
  if (prefs.savedVibes.length) lines.push(`Saved vibes: ${prefs.savedVibes.join('; ')}`);
  if (session.talkLevel) lines.push(`Current talk level preference: ${session.talkLevel}`);
  if (session.activity) lines.push(`Current listener activity: ${session.activity}`);
  if (session.mood) lines.push(`Current listener mood: ${session.mood}`);
  if (session.recentSignals.length) {
    lines.push(`Recent listener signals: ${session.recentSignals.map(signal => signal.text).join('; ')}`);
  }
  const episodes = recentEpisodes(memory.relationship);
  if (episodes.length) {
    lines.push(`Recent explicit listener moments:\n${episodes.map(formatEpisodeForPrompt).join('\n')}`);
  }

  return lines.length
    ? lines.join('\n')
    : 'No dynamic DJ memory yet. Use explicit listener feedback carefully when it appears.';
}

function captureUserSignal(message, intent = {}, nowPlaying = null) {
  if (!message || intent.source === 'autoRefill') return null;
  const text = String(message).trim();
  if (!text) return null;

  const memory = loadDjMemory();
  const updates = [];
  const lower = text.toLowerCase();
  const track = normalizeTrack(nowPlaying);

  if (/(少说点|别说太多|不要说太多|安静点|话少点|less talk|less talking|quiet)/i.test(text)) {
    memory.session.talkLevel = 'quiet';
    addUnique(memory.preferences.hostModeHints, 'Prefers sparse DJ talk when requested.');
    updates.push('talk_level:quiet');
    addEpisode(memory.relationship.episodes, {
      kind: 'host_style',
      text,
      note: 'listener asked for sparse DJ talk',
    }, memory);
  } else if (/(多说点|多讲点|讲讲背景|多介绍|more context|talk more|tell me more)/i.test(text)) {
    memory.session.talkLevel = 'hosty';
    addUnique(memory.preferences.hostModeHints, 'Enjoys more musical context when requested.');
    updates.push('talk_level:hosty');
    addEpisode(memory.relationship.episodes, {
      kind: 'host_style',
      text,
      note: 'listener asked for more musical context',
    }, memory);
  }

  if (track && isCurrentTrackPositive(text, lower)) {
    addUniqueTrack(memory.preferences.likedTracks, track);
    if (track.artist) addUnique(memory.preferences.likedArtists, track.artist);
    updates.push(`liked_track:${trackLabel(track)}`);
    addEpisode(memory.relationship.episodes, {
      kind: 'liked_track',
      text,
      track,
      note: 'listener liked the current track',
    }, memory);
  }

  if (track && isCurrentTrackNegative(text, lower)) {
    addUniqueTrack(memory.preferences.dislikedTracks, track);
    if (/(这个歌手|这个艺人|this artist|the artist)/i.test(text) && track.artist) {
      addUnique(memory.preferences.dislikedArtists, track.artist);
      addUnique(memory.preferences.avoidedArtists, track.artist);
      updates.push(`avoid_artist:${track.artist}`);
      addEpisode(memory.relationship.episodes, {
        kind: 'avoided_artist',
        text,
        artist: track.artist,
        track,
        note: 'listener disliked the current artist',
      }, memory);
    } else {
      updates.push(`disliked_track:${trackLabel(track)}`);
      addEpisode(memory.relationship.episodes, {
        kind: 'disliked_track',
        text,
        track,
        note: 'listener disliked the current track',
      }, memory);
    }
  }

  const avoidedArtist = extractAvoidedArtist(text);
  if (avoidedArtist) {
    addUnique(memory.preferences.avoidedArtists, avoidedArtist);
    addUnique(memory.preferences.dislikedArtists, avoidedArtist);
    updates.push(`avoid_artist:${avoidedArtist}`);
    addEpisode(memory.relationship.episodes, {
      kind: 'avoided_artist',
      text,
      artist: avoidedArtist,
      track,
      note: 'listener asked to avoid this artist',
    }, memory);
  }

  const savedVibe = extractSavedVibe(text, track);
  if (savedVibe) {
    addUnique(memory.preferences.savedVibes, savedVibe);
    updates.push(`saved_vibe:${savedVibe}`);
    addEpisode(memory.relationship.episodes, {
      kind: 'saved_vibe',
      text,
      track,
      note: savedVibe,
    }, memory);
  }

  const sessionSignal = classifySessionSignal(text, lower, intent);
  if (sessionSignal) {
    if (sessionSignal.mood) memory.session.mood = sessionSignal.mood;
    if (sessionSignal.activity) memory.session.activity = sessionSignal.activity;
    addRecentSignal(memory.session.recentSignals, sessionSignal);
    updates.push(`session:${sessionSignal.text}`);
    addEpisode(memory.relationship.episodes, {
      kind: sessionSignal.type,
      text,
      mood: sessionSignal.mood,
      activity: sessionSignal.activity,
      track,
      note: 'listener described the current moment',
    }, memory);
  }

  if (!updates.length) return null;
  saveDjMemory(memory);
  return updates;
}

function isCurrentTrackPositive(text, lower) {
  if (/(more like this|更多类似|多来这种|这个方向不错)/i.test(text)) return true;
  return /(这首|这歌|当前|刚才|this song|this track|current track)/i.test(text) &&
    /(喜欢|不错|好听|对味|可以|love|like|good|great|nice|works)/i.test(lower) &&
    !/(不喜欢|不好听|not good|don't like|do not like)/i.test(lower);
}

function isCurrentTrackNegative(text, lower) {
  if (/(less like this|少来这种|少播这种|别太像这首)/i.test(text)) return true;
  return /(这首|这歌|当前|刚才|this song|this track|current track)/i.test(text) &&
    /(不喜欢|不好听|难听|不对|不是这种|跳过|别播|don't like|do not like|not this|wrong|skip)/i.test(lower);
}

function classifySessionSignal(text, lower, intent = {}) {
  if (intent.userIntent === 'correction') {
    return { type: 'correction', text: compact(text) };
  }
  if (/(我在工作|正在工作|工作中|working|at work)/i.test(text)) {
    return { type: 'activity', activity: 'working', text: compact(text) };
  }
  if (/(学习|写代码|coding|study|studying|focus)/i.test(text)) {
    return { type: 'activity', activity: 'focused', text: compact(text) };
  }
  if (/(有点累|很累|疲惫|tired|rough day|long day)/i.test(text)) {
    return { type: 'mood', mood: 'tired', text: compact(text) };
  }
  if (/(难过|低落|down|sad|heavy)/i.test(text)) {
    return { type: 'mood', mood: 'low', text: compact(text) };
  }
  if (/(开心|兴奋|高兴|happy|excited)/i.test(text)) {
    return { type: 'mood', mood: 'bright', text: compact(text) };
  }
  return null;
}

function extractAvoidedArtist(text) {
  const match = text.match(/(?:别播|不要播|不想听|don't play|do not play)\s*([^，。,.!?！？]{2,60})/i);
  if (!match) return null;
  const value = compact(match[1]).replace(/^(这个|that|this)\s*/i, '');
  if (/^(这首|这歌|歌|歌曲|music|song|track)$/i.test(value)) return null;
  return value;
}

function extractSavedVibe(text, track) {
  if (!/(保存这个氛围|记住这个氛围|这个氛围不错|save this vibe|remember this vibe|save the vibe)/i.test(text)) {
    return null;
  }
  const label = trackLabel(track);
  return label
    ? `Saved the vibe around ${label}`
    : 'Saved the current station vibe';
}

function recentSession(session = {}) {
  const cutoff = Date.now() - SESSION_SIGNAL_TTL_MS;
  const recentSignals = Array.isArray(session.recentSignals)
    ? session.recentSignals.filter(signal => Number(signal.at) >= cutoff)
    : [];
  return {
    talkLevel: session.talkLevel || null,
    mood: recentSignals.some(signal => signal.mood === session.mood) ? session.mood : null,
    activity: recentSignals.some(signal => signal.activity === session.activity) ? session.activity : null,
    recentSignals,
  };
}

function recentEpisodes(relationship = {}) {
  return Array.isArray(relationship.episodes)
    ? relationship.episodes.slice(0, MAX_PROMPT_EPISODES)
    : [];
}

function mergeMemory(value) {
  return {
    ...DEFAULT_MEMORY,
    ...value,
    preferences: {
      ...DEFAULT_MEMORY.preferences,
      ...(value.preferences || {}),
    },
    session: {
      ...DEFAULT_MEMORY.session,
      ...(value.session || {}),
    },
    relationship: {
      ...DEFAULT_MEMORY.relationship,
      ...(value.relationship || {}),
    },
  };
}

function normalizeTrack(track) {
  if (!track || !track.title) return null;
  return {
    title: compact(track.title),
    artist: compact(track.artist || ''),
  };
}

function addUnique(list, value) {
  const cleaned = compact(value);
  if (!cleaned) return;
  const exists = list.some(item => item.toLowerCase() === cleaned.toLowerCase());
  if (!exists) list.unshift(cleaned);
  trimList(list);
}

function addUniqueTrack(list, track) {
  if (!track?.title) return;
  const exists = list.some(item =>
    item.title?.toLowerCase() === track.title.toLowerCase() &&
    String(item.artist || '').toLowerCase() === String(track.artist || '').toLowerCase()
  );
  if (!exists) list.unshift(track);
  trimList(list);
}

function addRecentSignal(list, signal) {
  list.unshift({
    ...signal,
    text: compact(signal.text),
    at: Date.now(),
  });
  trimList(list, MAX_RECENT_SIGNALS);
}

function addEpisode(list, episode, memory) {
  if (!Array.isArray(list)) return;
  const normalized = {
    kind: compact(episode.kind || 'listener_signal'),
    text: compact(episode.text).slice(0, 180),
    note: compact(episode.note).slice(0, 180),
    track: normalizeTrack(episode.track),
    artist: compact(episode.artist || episode.track?.artist || ''),
    mood: compact(episode.mood || memory.session.mood || ''),
    activity: compact(episode.activity || memory.session.activity || ''),
    at: Date.now(),
  };
  if (!normalized.text && !normalized.note && !normalized.track && !normalized.artist) return;
  list.unshift(normalized);
  trimList(list, MAX_EPISODES);
}

function trimList(list, max = MAX_LIST_ITEMS) {
  while (list.length > max) list.pop();
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function trackLabel(track) {
  if (!track) return '';
  return `${track.title}${track.artist ? ` - ${track.artist}` : ''}`;
}

function formatEpisodeForPrompt(episode) {
  const parts = [`- ${episode.kind || 'listener_signal'}`];
  const track = trackLabel(episode.track);
  if (track) parts.push(track);
  else if (episode.artist) parts.push(`artist: ${episode.artist}`);
  if (episode.mood) parts.push(`mood: ${episode.mood}`);
  if (episode.activity) parts.push(`activity: ${episode.activity}`);
  if (episode.text) parts.push(`listener said: "${episode.text}"`);
  if (episode.note) parts.push(`note: ${episode.note}`);
  return parts.join(' | ');
}

module.exports = {
  captureUserSignal,
  formatDjMemoryForPrompt,
  loadDjMemory,
};
