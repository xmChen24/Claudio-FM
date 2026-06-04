const NEXT_PATTERNS = /^(下一首|next|skip|跳过)$/i;
const PAUSE_PATTERNS = /^(暂停|pause|停一下)$/i;
const RESUME_PATTERNS = /^(继续|resume|play|播放)$/i;
const VOL_UP = /^(大声|音量大|louder|vol\s*up)$/i;
const VOL_DOWN = /^(小声|音量小|quieter|vol\s*down)$/i;
const SPEECH_ONLY_PATTERNS = /(测试.*声音|不要换歌|别换歌|不换歌|介绍当前|介绍一下当前|随便说两句|只说话|no\s*music|speech\s*only|what'?s playing)/i;
const VIBE_COMMAND_PATTERNS = /^(?:more\s+like\s+this|change\s+the\s+vibe|keep\s+the\s+next\s+set|retune\b|换.*(?:氛围|风格)|更多类似)/i;
const GENERAL_MUSIC_PATTERNS = /(start|open|retune|change\s+the\s+vibe|more\s+like|keep\s+the\s+next\s+set|pick\s+whatever|radio|station|playlist|^\s*(?:some\s+)?(?:music|songs?|tracks?)\s*$|vibe|mood|开播|开始|电台|换.*氛围|换.*风格|更多类似|歌单|(?:我想听|想听|来一首|来点|放点|播放|换|点播).*(?:歌|音乐|歌曲|氛围)|氛围|适合|工作|学习|睡觉|放松|提神|通勤|深夜|早晨|早上|下午|夜晚)/i;
const CONVERSATION_PATTERNS = /([?？]|为什么|怎么|如何|什么|你觉得|你认为|能不能解释|解释一下|聊聊|说说|告诉我|回答我|\b(hello|hi|hey|thanks|thank you|why|how|what|who)\b|tell me|explain|do you think|can you answer)/i;
const EN_TRACK_BY_ARTIST = /^(?:play|put on|listen to|i want to hear|i wanna hear|can you play|please play)\s+(.+?)\s+by\s+(.+?)\s*$/i;
const EN_POSSESSIVE_TRACK = /^(?:play|put on|listen to|i want to hear|i wanna hear|can you play|please play)\s+(.+?)['’]s\s+(.+?)\s*$/i;
const EN_ARTIST = /^(?:play|put on|listen to|i want to hear|i wanna hear|can you play|please play)\s+(?:some\s+)?(.+?)(?:'s)?\s+(?:songs?|tracks?|music)\s*$/i;
const EN_DIRECT = /^(?:play|put on|listen to|i want to hear|i wanna hear|can you play|please play)\s+(.+?)\s*$/i;
const ZH_ARTIST = /^(?:我想听|想听|播放|放|点播|来一首|来点)?\s*(.+?)\s*的(?:歌|歌曲|音乐)\s*$/i;
const ZH_TRACK_BY_ARTIST = /^(?:请|帮我|可以|能不能|我想听|想听|播放|放点|放一首|放|点播|来一首|来点|听一下|听)?\s*(.+?)\s*(?:的|唱的)\s*[《"“]?(.+?)[》"”]?\s*$/i;
const ZH_QUOTED_TRACK = /^(?:请|帮我|可以|能不能|我想听|想听|播放|放点|放一首|放|点播|来一首|来点|听一下|听)?\s*[《"“](.+?)[》"”]\s*$/i;
const ZH_DIRECT = /^(?:请|帮我|可以|能不能|我想听|想听|播放|放点|放一首|放|点播|来一首|来点|听一下)\s*(.+?)\s*$/i;
const DASH_TRACK = /^(.+?)\s*[-—–]\s*(.+?)$/u;
const BARE_DIRECT = /^[\p{Letter}\p{Number}][\p{Letter}\p{Number}\s.'’&-]{1,80}$/u;
const BARE_NON_REQUEST_WORDS = /(今天|昨天|明天|有点|很累|难过|开心|问题|解释|聊聊|你|我|这首|这歌|当前|刚才|不错|好听|不好听|喜欢|不喜欢|一般|难听|\b(i|me|my|you|your|we|this|that|today|tomorrow|yesterday|had|feel|feeling|rough|tired|sad|happy|question|answer|hello|hi|hey|thanks|thank|more|like|start|open|tune|vibe|mood|radio|station|show|songs?|music|playlist|claudio|fm)\b)/i;
const DESCRIPTIVE_MUSIC_TARGETS = /(适合|工作|学习|睡觉|放松|提神|通勤|深夜|早晨|早上|下午|夜晚|氛围|心情|情绪|vibe|mood|focus|work|study|sleep|relax|commute)/i;
const GENERIC_MUSIC_QUERY = /^(歌|歌曲|音乐|music|songs?|tracks?)$/i;
const POSITIVE_FEEDBACK_PATTERNS = /(这首|这歌|当前|刚才|this song|this track|current track).*(喜欢|不错|好听|对味|可以|love|like|good|great|nice|works)/i;
const NEGATIVE_FEEDBACK_PATTERNS = /(这首|这歌|当前|刚才|this song|this track|current track).*(不喜欢|不好听|难听|不对|不是这种|跳过|别播|don't like|do not like|not this|wrong|skip)/i;
const CORRECTION_PATTERNS = /(不是这种|不对|不是这个|点错了|换一个版本|not this|not that|wrong version|wrong song)/i;
const SESSION_CONTEXT_PATTERNS = /(我在工作|正在工作|工作中|学习|写代码|有点累|很累|疲惫|难过|低落|开心|兴奋|working|at work|studying|coding|focus|tired|rough day|long day|sad|happy|excited)/i;
const HOST_STYLE_PATTERNS = /(少说点|别说太多|不要说太多|安静点|话少点|多说点|多讲点|讲讲背景|多介绍|less talk|less talking|quiet|more context|talk more|tell me more)/i;

function parseMusicRequest(message) {
  const msg = message.trim();
  let match = msg.match(EN_TRACK_BY_ARTIST);
  if (match) {
    const title = cleanRequestTarget(match[1]);
    const artist = cleanRequestTarget(match[2]);
    if (title && artist) return { kind: 'track', query: `${title} - ${artist}`, title, artist, userIntent: 'exact_track_request' };
  }

  match = msg.match(EN_POSSESSIVE_TRACK);
  if (match) {
    const artist = cleanRequestTarget(match[1]);
    const title = cleanRequestTarget(match[2]);
    if (title && artist && !GENERIC_MUSIC_QUERY.test(title)) {
      return { kind: 'track', query: `${title} - ${artist}`, title, artist, userIntent: 'exact_track_request' };
    }
  }

  match = msg.match(DASH_TRACK);
  if (match && looksLikeDashTrackRequest(msg)) {
    const left = cleanRequestTarget(match[1]);
    const right = cleanRequestTarget(match[2]);
    if (left && right && !GENERIC_MUSIC_QUERY.test(left) && !GENERIC_MUSIC_QUERY.test(right)) {
      return { kind: 'track', query: `${left} - ${right}`, title: left, artist: right, userIntent: 'exact_track_request' };
    }
  }

  match = msg.match(ZH_TRACK_BY_ARTIST);
  if (match) {
    const artist = cleanRequestTarget(match[1]);
    const title = cleanRequestTarget(match[2]);
    if (artist && title && !GENERIC_MUSIC_QUERY.test(title) && !DESCRIPTIVE_MUSIC_TARGETS.test(title)) {
      return { kind: 'track', query: `${title} - ${artist}`, title, artist, userIntent: 'exact_track_request' };
    }
  }

  match = msg.match(ZH_QUOTED_TRACK);
  if (match) {
    const query = cleanRequestTarget(match[1]);
    if (query && !GENERIC_MUSIC_QUERY.test(query)) return { kind: 'unknown', query, title: query, prefer: 'track', userIntent: 'direct_music_request' };
  }

  match = msg.match(EN_ARTIST) || msg.match(ZH_ARTIST);
  if (match) {
    const artist = cleanRequestTarget(match[1]);
    if (DESCRIPTIVE_MUSIC_TARGETS.test(artist)) return null;
    if (artist) return { kind: 'artist', query: artist, artist, userIntent: 'artist_request' };
  }

  match = msg.match(EN_DIRECT) || msg.match(ZH_DIRECT);
  if (match) {
    const query = cleanRequestTarget(match[1]);
    if (GENERIC_MUSIC_QUERY.test(query)) return null;
    if (query) return { kind: 'unknown', query, title: query, prefer: 'track', userIntent: 'direct_music_request' };
  }

  const cleanedBare = cleanRequestTarget(msg);
  if (cleanedBare && cleanedBare !== msg && !GENERIC_MUSIC_QUERY.test(cleanedBare)) {
    return { kind: 'unknown', query: cleanedBare, title: cleanedBare, prefer: 'track', userIntent: 'direct_music_request' };
  }

  if (BARE_DIRECT.test(msg) && msg.split(/\s+/).length <= 5 && !BARE_NON_REQUEST_WORDS.test(msg)) {
    return { kind: 'unknown', query: cleanRequestTarget(msg), userIntent: 'direct_music_request' };
  }

  return null;
}

function looksLikeDashTrackRequest(message) {
  const msg = String(message || '').trim();
  if (!msg || msg.length > 96) return false;
  if (/[。！？!?;；:：()（）]/.test(msg)) return false;
  if (/\b(?:more\s+like|change\s+the\s+vibe|keep\s+the\s+next\s+set|pick\s+whatever|open\s+the\s+station|you'?re\s+on\s+air)\b/i.test(msg)) return false;
  const parts = msg.split(/\s*[-—–]\s*/).map(part => part.trim()).filter(Boolean);
  if (parts.length !== 2) return false;
  return parts.every(part => part.length >= 1 && part.length <= 48);
}

function cleanRequestTarget(value) {
  return String(value || '')
    .replace(/[。！？.!?]+$/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^(?:please\s*)?(?:play|put on|listen to|hear)\s*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/iu, '')
    .replace(/^(?:请|帮我|可以|能不能)?\s*(?:我想听|想听|播放|放点|放一首|放|点播|来一首|来点|听一下|听)\s*/i, '')
    .trim();
}

function route(message) {
  const msg = message.trim();
  if (NEXT_PATTERNS.test(msg)) return { action: 'next' };
  if (PAUSE_PATTERNS.test(msg)) return { action: 'pause' };
  if (RESUME_PATTERNS.test(msg)) return { action: 'resume' };
  if (VOL_UP.test(msg)) return { action: 'volume', delta: +10 };
  if (VOL_DOWN.test(msg)) return { action: 'volume', delta: -10 };
  if (SPEECH_ONLY_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'speech_only' };
  if (CORRECTION_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'correction' };
  if (NEGATIVE_FEEDBACK_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'negative_feedback' };
  if (POSITIVE_FEEDBACK_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'positive_feedback' };
  if (HOST_STYLE_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'host_style_feedback' };
  if (SESSION_CONTEXT_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'session_context' };
  if (VIBE_COMMAND_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'music', musicRequest: null, userIntent: 'vibe_request' };
  const musicRequest = parseMusicRequest(msg);
  if (musicRequest) return { action: 'claude', message: msg, mode: 'music', musicRequest, userIntent: musicRequest.userIntent };
  if (CONVERSATION_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'conversation' };
  if (GENERAL_MUSIC_PATTERNS.test(msg)) return { action: 'claude', message: msg, mode: 'music', musicRequest: null, userIntent: 'vibe_request' };
  return { action: 'claude', message: msg, mode: 'speech-only', userIntent: 'conversation' };
}

module.exports = { route };
