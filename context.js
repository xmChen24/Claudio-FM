const fs = require('fs');
const path = require('path');
const { recentPlays, recentMessages } = require('./state');
const { environmentPromptText } = require('./env-context');
const { formatDjMemoryForPrompt } = require('./dj-memory');
const { formatProgramArcForPrompt } = require('./program-arc');
const { formatCorrectionForPrompt } = require('./dj-correction');

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function sharedContext({ includeTaste = true, includeDialog = true, recentPlayLimit = 20 } = {}) {
  const persona = readFile(path.join(__dirname, 'prompts/dj-persona.md'));
  const taste = readFile(path.join(__dirname, 'user/taste.md'));
  const routines = readFile(path.join(__dirname, 'user/routines.md'));
  const moodRules = readFile(path.join(__dirname, 'user/mood-rules.md'));
  const djMemory = formatDjMemoryForPrompt();
  const env = environmentPromptText();
  const plays = recentPlays(recentPlayLimit);
  const historyText = plays.length
    ? plays.map(p => `- ${p.title}${p.artist ? ' — ' + p.artist : ''}`).join('\n')
    : '（暂无播放记录）';
  const messages = includeDialog ? recentMessages(8) : [];
  const dialogText = messages.length
    ? messages.map(m => `${m.role === 'user' ? '用户' : 'Claudio'}: ${m.content}`).join('\n')
    : '';

  return [
    persona,
    includeTaste ? `# 用户音乐品味\n${taste}` : '',
    routines ? `# 用户作息\n${routines}` : '',
    moodRules ? `# 情绪规则\n${moodRules}` : '',
    `# 动态 DJ 记忆\n${djMemory}`,
    `# 环境\n${env}`,
    `# 最近播放历史（最近${recentPlayLimit}首）\n${historyText}`,
    dialogText ? `# 最近 on-air / call-in 历史\n${dialogText}` : '',
  ].filter(Boolean).join('\n\n');
}

function intentDetailText(options = {}) {
  const lines = [];
  if (options.userIntent) lines.push(`User intent: ${options.userIntent}`);
  if (options.musicRequest) {
    const request = options.musicRequest;
    lines.push(`Music request type: ${request.kind || 'unknown'}`);
    if (request.query) lines.push(`Requested query: ${request.query}`);
    if (request.title) lines.push(`Requested track title: ${request.title}`);
    if (request.artist) lines.push(`Requested artist: ${request.artist}`);
  }
  return lines.join('\n');
}

function programArcText(options = {}) {
  return formatProgramArcForPrompt(options.programArc || null);
}

function correctionText(options = {}) {
  return formatCorrectionForPrompt(options.correctionContext || null);
}

function normalizeDjLanguage(language) {
  return language === 'zh' ? 'zh' : 'en';
}

function normalizeHostMode(mode) {
  return ['quiet', 'story', 'companion'].includes(mode) ? mode : 'story';
}

function hostModeInstruction(mode) {
  const normalized = normalizeHostMode(mode);
  if (normalized === 'quiet') {
    return 'Host mode: Quiet. Speak sparingly, keep DJ lines short, and let the music carry the room.';
  }
  if (normalized === 'companion') {
    return 'Host mode: Companion. Respond to the listener like a warm private radio host, while staying restrained and not chatty.';
  }
  return 'Host mode: Story. Add concise musical context, origin, texture, or scene-setting when it helps the track feel chosen.';
}

function djLanguageInstruction(language, scope = 'spoken segment text') {
  if (normalizeDjLanguage(language) === 'zh') {
    return `All ${scope} must be in natural, restrained Chinese. Keep song titles and artist names in their original language for accurate music search.`;
  }
  return `All ${scope} must be in English unless the listener explicitly requests Chinese.`;
}

function coldOpenLengthInstruction(language) {
  return normalizeDjLanguage(language) === 'zh'
    ? 'The full cold open should sound like live radio, use concrete musical detail, and stay around 70-140 Chinese characters across all cold_open parts.'
    : 'The full cold open should sound like live radio, use concrete musical detail, and stay around 45-90 English words across all cold_open parts.';
}

function coldOpenRadioHostInstruction(language) {
  if (normalizeDjLanguage(language) === 'zh') {
    return [
      'Cold open voice: 像真人电台主持人开麦，不像推荐理由、散文、影评或百科词条。',
      '默认结构：先给一个当下时段/情绪/场景的短钩子；再给一个准确的歌曲、歌手、制作、采样、专辑语境或声音细节；最后用一句自然 handoff 进歌。',
      '每段只做一个口播动作。不要堆形容词，不要解释算法，不要说“我为你生成/安排/推荐”。',
      '少用抽象包装词，尤其避免反复使用：signal、room、color、light、breath、horizon、drift，以及“第一层颜色”“把房间带进去”这类空泛句式。',
      '如果事实不确定，就讲听感、编曲、flow、hook、声线、节奏或已知的发行语境；不要编造趣事。',
      '遇到 rap / hip-hop，优先讲一个具体角度：制作质感、采样/鼓组、flow、旋律 hook、地域/厂牌气质、职业阶段、代表性合作、公众关注点。避免八卦和未经确认的争议。',
      '好例子：下午的速度可以往前推一点。Drake 这类半唱半说的 hook 最适合把节奏抬起来，但不把桌面掀翻。先让这首进来。',
      '坏例子：这段信号从第一层颜色里展开，让房间被命运照亮。',
    ].join('\n');
  }

  return [
    'Cold open voice: write like a real radio host opening a mic break, not a recommendation paragraph, poetry caption, album review, or encyclopedia entry.',
    'Default shape: one immediate hook tied to the moment; one accurate track/artist/production/sample/album-context or sound detail; one short handoff into the intro.',
    'Each segment should do one on-air job. Do not stack adjectives, explain the algorithm, or say "I generated/chose/recommended this for you."',
    'Avoid vague recurring AI imagery and filler, especially: signal, room, color, light, breath, horizon, drift, first color, let the room, kind of, a little.',
    'If a fact is uncertain, describe sound, arrangement, flow, hook, vocal texture, rhythm, or known release context instead of inventing trivia.',
    'For rap / hip-hop, prefer one concrete angle: production texture, sample feel, drums, flow, melodic hook, regional scene, career phase, notable collaboration, public focus, or why that rapper is being watched. Avoid gossip and unverified controversy.',
    'Good example: "Saturday afternoon can use a beat with some forward lean. Drake keeps this one half-sung and close to the hook, so it moves without crowding the room. Let it ride."',
    'Bad example: "This signal opens inside a room of shadow and color, where emotion becomes motion."',
  ].join('\n');
}

function bridgeLengthInstruction(language) {
  return normalizeDjLanguage(language) === 'zh'
    ? 'Bridge segments should be brief and conversational, usually 18-55 Chinese characters total. Silence segments are valid deliberate choices.'
    : 'Bridge segments should be brief and conversational, usually 12-35 English words total. Silence segments are valid deliberate choices.';
}

function buildPrompt(userInput, queueState = '', options = {}) {
  const djLanguage = normalizeDjLanguage(options.djLanguage);
  const hostMode = normalizeHostMode(options.hostMode);
  const intentText = options.mode === 'speech-only'
    ? 'Intent: speech-only / no-music. Answer the listener directly and truthfully. Do not recommend, replace, or add songs. Return an empty play array and one immediate quick_touch segment with the direct reply.'
    : 'Intent: music radio segment. Unless the user asked for one specific song, return a mini set of 2-3 playable songs.';
  const intentDetails = intentDetailText(options);
  const arcDetails = programArcText(options);
  const correctionDetails = correctionText(options);

  const parts = [
    sharedContext(),
    queueState ? `# 当前队列状态\n${queueState}` : '',
    `# 当前请求意图\n${intentText}`,
    intentDetails ? `# 意图细节\n${intentDetails}` : '',
    arcDetails ? `# 当前节目弧线\n${arcDetails}` : '',
    correctionDetails ? `# 纠错上下文\n${correctionDetails}` : '',
    `# 用户输入\n${userInput}`,
    [
      'Strictly output JSON only, with no extra text.',
      djLanguageInstruction(djLanguage),
      hostModeInstruction(hostMode),
      'The "title" should use the same language as the DJ narration.',
      'The "play" array may keep song titles and artist names in their original language for accurate music search.',
      'For speech-only / no-music requests, "play" must be [] and segments must not alter the queue. If the listener asks a factual or personal question, answer it directly instead of turning it into a station retune.',
      'For positive_feedback, negative_feedback, correction, or session_context, acknowledge the listener naturally and use the dynamic DJ memory for future tone; do not pretend a new song was requested.',
      'Default to 2–3 songs per set unless the user asks for one specific track.',
      'Do not repeat any song from the recent play history or current queue. Do not include the same song twice in one play array.',
      'Avoid artists that appear in the most recent 5 played songs unless the listener explicitly asked for that artist.',
      '"title" is a 2–4 word evocative segment name (or "" if nothing fits).',
      'Return "segments" as an array of radio script actions. Supported types: cold_open, bridge, quick_touch, back_announce, silence. Supported positions: before_track, between_tracks, after_track, immediate.',
      'For normal music sets, include a cold open before trackIndex 0 unless silence is clearly better. Write it as 2–4 consecutive cold_open segments, each with one sentence, the same position/trackIndex, and optional part values: anchor, heart, turn, invitation.',
      coldOpenLengthInstruction(djLanguage),
      coldOpenRadioHostInstruction(djLanguage),
      `Bridge segments should be bound between tracks with afterTrackIndex and beforeTrackIndex. ${bridgeLengthInstruction(djLanguage)}`,
      'Vary your rhythm: do not narrate every track the same way. If your recent on-air lines in the dialog history were long, keep this one short or silent. The music is the point; your voice frames it.',
      '{"title":"program moment name","play":["song - artist"],"segments":[{"type":"cold_open","part":"anchor","position":"before_track","trackIndex":0,"text":"One sentence of DJ narration."},{"type":"cold_open","part":"turn","position":"before_track","trackIndex":0,"text":"One sentence that continues the opening."},{"type":"cold_open","part":"invitation","position":"before_track","trackIndex":0,"text":"One short sentence into the music."},{"type":"bridge","position":"between_tracks","afterTrackIndex":0,"beforeTrackIndex":1,"text":"bridge over track 1 outro into track 2"},{"type":"silence","position":"between_tracks","afterTrackIndex":1,"beforeTrackIndex":2,"text":""}],"reason":"internal reason"}',
    ].join('\n'),
  ];

  return parts.filter(Boolean).join('\n\n');
}

function buildProgramStartPrompt(userInput, queueState = '', options = {}) {
  const djLanguage = normalizeDjLanguage(options.djLanguage);
  const hostMode = normalizeHostMode(options.hostMode);
  const intentDetails = intentDetailText(options);
  const arcDetails = programArcText(options);
  const correctionDetails = correctionText(options);
  return [
    sharedContext({ includeDialog: false, recentPlayLimit: 12 }),
    queueState ? `# 当前队列状态\n${queueState}` : '',
    `# 电台任务\nprogram_start：开播选歌，并为 play[0] 写一段可直接播出的完整 cold_open。`,
    intentDetails ? `# 意图细节\n${intentDetails}` : '',
    arcDetails ? `# 当前节目弧线\n${arcDetails}` : '',
    correctionDetails ? `# 纠错上下文\n${correctionDetails}` : '',
    `# 用户输入 / 启动意图\n${userInput}`,
    [
      'Strictly output JSON only, with no extra text.',
      djLanguageInstruction(djLanguage, 'cold_open segment text'),
      hostModeInstruction(hostMode),
      'The "title" should use the same language as the DJ narration.',
      'Return only fields allowed by the JSON schema. Use title, play, segments, reason, mode, say, and intros. Keep say "" and intros [].',
      'The "play" array must contain 2-3 songs in "song title - artist" format. Keep original-language titles/artists for search.',
      'The "segments" array must contain 2-4 cold_open segments for play[0], each one sentence, position before_track, trackIndex 0, groupId "open_0".',
      'Do not repeat any song from the recent play history or current queue. Do not include the same song twice in one play array.',
      'Avoid artists that appear in the most recent 5 played songs unless the listener explicitly asked for that artist.',
      'Use dynamic DJ memory as taste and tone guidance, but do not mention the memory system.',
      'If correction context is present, recover from the rejected lane and do not choose the rejected current track or artist unless explicitly required.',
      'The cold_open must introduce play[0] specifically. If you mention a title or artist, it must come from play[0].',
      coldOpenLengthInstruction(djLanguage),
      coldOpenRadioHostInstruction(djLanguage),
      'Do not say "This is Claudio", "coming up next", "let me", "okay", or explain that you are generating a program.',
      '{"title":"program moment name","say":"","play":["song - artist","song - artist"],"segments":[{"type":"cold_open","groupId":"open_0","part":"anchor","position":"before_track","trackIndex":0,"text":"One sentence about play[0]."},{"type":"cold_open","groupId":"open_0","part":"turn","position":"before_track","trackIndex":0,"text":"One sentence that develops the opening."},{"type":"cold_open","groupId":"open_0","part":"invitation","position":"before_track","trackIndex":0,"text":"One short sentence into the first track."}],"intros":[],"reason":"internal reason","mode":"program_start"}',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildColdOpenForTracksPrompt({ programTitle = '', tracks = [], userInput = '', djLanguage = 'en', hostMode = 'story', userIntent = '', musicRequest = null, programArc = null, correctionContext = null, leadInText = '', directRequest = false } = {}) {
  const normalizedLanguage = normalizeDjLanguage(djLanguage);
  const normalizedHostMode = normalizeHostMode(hostMode);
  const intentDetails = intentDetailText({ userIntent, musicRequest });
  const arcDetails = programArcText({ programArc });
  const correctionDetails = correctionText({ correctionContext });
  const trackText = tracks.length
    ? tracks.map((track, i) => `${i}. ${track.title || track.query}${track.artist ? ' — ' + track.artist : ''}`).join('\n')
    : '（无可播放歌曲）';

  return [
    sharedContext({
      includeDialog: !directRequest,
      recentPlayLimit: directRequest ? 6 : 12,
    }),
    `# 电台任务\ncold_open_for_resolved_tracks：根据已经确认可播放的真实歌曲生成开场播报。`,
    programTitle ? `# 当前节目标题\n${programTitle}` : '',
    intentDetails ? `# 意图细节\n${intentDetails}` : '',
    arcDetails ? `# 当前节目弧线\n${arcDetails}` : '',
    correctionDetails ? `# 纠错上下文\n${correctionDetails}` : '',
    userInput ? `# 用户输入 / 启动意图\n${userInput}` : '',
    leadInText ? `# 已经播出的 cold open 第一句\n${leadInText}` : '',
    `# 已确认可播放歌曲（必须以此为准）\n${trackText}`,
    [
      'Strictly output JSON only, with no extra text.',
      'Return only: {"segments":[...],"reason":"internal reason"}.',
      djLanguageInstruction(normalizedLanguage, 'cold_open segment text'),
      hostModeInstruction(normalizedHostMode),
      'The opening is for trackIndex 0 and must introduce the first confirmed playable track.',
      leadInText
        ? 'Continue after the already-aired first sentence. Do not repeat or paraphrase that sentence.'
        : 'Start with a concrete first sentence for the confirmed first track.',
      'If you mention a song title or artist, it must exactly be from the confirmed playable song list above.',
      'Do not mention or describe any song that is not in the confirmed playable song list.',
      'The "segments" array must contain only cold_open segments for trackIndex 0.',
      'Write 2-4 consecutive cold_open segments, each one sentence, same position before_track and trackIndex 0.',
      directRequest
        ? 'This is a direct listener request with the song already resolved. Do not plan a broader set; focus on why this exact confirmed song fits the request.'
        : 'Keep the opening connected to the broader program arc without drifting away from the first confirmed track.',
      coldOpenLengthInstruction(normalizedLanguage),
      coldOpenRadioHostInstruction(normalizedLanguage),
      'Use optional part values: anchor, heart, turn, image, invitation.',
      '{"segments":[{"type":"cold_open","groupId":"open_0","part":"anchor","position":"before_track","trackIndex":0,"text":"One sentence about the exact first confirmed track."},{"type":"cold_open","groupId":"open_0","part":"turn","position":"before_track","trackIndex":0,"text":"One sentence that stays accurate to the confirmed tracks."},{"type":"cold_open","groupId":"open_0","part":"invitation","position":"before_track","trackIndex":0,"text":"One short sentence into the first track."}],"reason":"internal reason"}',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildMusicRefillPrompt({ programTitle = '', currentTrack = null, queue = [], count = 3, hostMode = 'story', programArc = null } = {}) {
  const normalizedHostMode = normalizeHostMode(hostMode);
  const arcDetails = programArcText({ programArc });
  const queueText = queue.length
    ? queue.map((t, i) => `${i + 1}. ${t.title || t.query}${t.artist ? ' — ' + t.artist : ''}`).join('\n')
    : '（当前队列为空）';
  const currentText = currentTrack ? `${currentTrack.title || currentTrack.query}${currentTrack.artist ? ' — ' + currentTrack.artist : ''}` : 'unknown';
  return [
    sharedContext({ includeDialog: false, recentPlayLimit: 20 }),
    `# 电台任务\nmusic_refill：只为当前电台补 ${count} 首歌。不要生成任何听众可见 DJ 播报。`,
    `# 当前节目\n${programTitle || 'Untitled program'}`,
    arcDetails ? `# 当前节目弧线\n${arcDetails}` : '',
    `# 当前正在播\n${currentText}`,
    `# 当前前端队列\n${queueText}`,
    [
      'Strictly output JSON only, with no extra text.',
      'Return only: {"play":["song - artist"],"reason":"internal reason"}.',
      hostModeInstruction(normalizedHostMode),
      `Return ${count} songs unless the queue context makes fewer safer.`,
      'Use the current program arc to continue the set instead of making an unrelated recommendation jump.',
      'Do not include segments, say, intros, or listener-facing explanations.',
      'Keep song titles and artist names in original language for accurate search.',
      'Do not repeat any song from the current queue or recent play history.',
      'Do not include the same song twice in one play array.',
      'Avoid artists that appear in the most recent 5 played songs unless the listener explicitly asked for that artist.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildBridgePrompt({ programTitle = '', afterTrack, beforeTrack, afterTrackIndex, beforeTrackIndex, recentLines = '', djLanguage = 'en', hostMode = 'story', programArc = null }) {
  const normalizedLanguage = normalizeDjLanguage(djLanguage);
  const normalizedHostMode = normalizeHostMode(hostMode);
  const arcDetails = programArcText({ programArc });
  const afterText = `${afterTrack?.title || afterTrack?.query || 'previous track'}${afterTrack?.artist ? ' — ' + afterTrack.artist : ''}`;
  const beforeText = `${beforeTrack?.title || beforeTrack?.query || 'next track'}${beforeTrack?.artist ? ' — ' + beforeTrack.artist : ''}`;
  return [
    sharedContext({ includeTaste: false, includeDialog: false, recentPlayLimit: 8 }),
    `# 电台任务\nbridge_generation：只生成从上一首到下一首的歌曲缝隙播报，或明确选择 silence。`,
    `# 当前节目\n${programTitle || 'Untitled program'}`,
    arcDetails ? `# 当前节目弧线\n${arcDetails}` : '',
    `# 上一首\nindex ${afterTrackIndex}: ${afterText}`,
    `# 下一首\nindex ${beforeTrackIndex}: ${beforeText}`,
    recentLines ? `# 最近播报摘要\n${recentLines}` : '',
    [
      'Strictly output JSON only, with no extra text.',
      djLanguageInstruction(normalizedLanguage, 'bridge segment text'),
      hostModeInstruction(normalizedHostMode),
      'Return only {"segments":[...],"reason":"internal reason"}.',
      'Output either 1-3 sentence-level bridge segments OR one silence segment.',
      'For bridge segments, use the same groupId, position between_tracks, and exact afterTrackIndex/beforeTrackIndex provided.',
      bridgeLengthInstruction(normalizedLanguage),
      'Allowed bridge part values: back_announce, pivot, handoff.',
      'Do not write a recommendation explanation. This is a live radio transition.',
      'If there is nothing worth saying, return one silence segment with text "".',
      `{"segments":[{"type":"bridge","groupId":"bridge_${afterTrackIndex}_${beforeTrackIndex}","part":"back_announce","position":"between_tracks","afterTrackIndex":${afterTrackIndex},"beforeTrackIndex":${beforeTrackIndex},"text":"One sentence."},{"type":"bridge","groupId":"bridge_${afterTrackIndex}_${beforeTrackIndex}","part":"handoff","position":"between_tracks","afterTrackIndex":${afterTrackIndex},"beforeTrackIndex":${beforeTrackIndex},"text":"One sentence into the next track."}],"reason":"internal reason"}`,
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

module.exports = { buildPrompt, buildProgramStartPrompt, buildColdOpenForTracksPrompt, buildMusicRefillPrompt, buildBridgePrompt };
