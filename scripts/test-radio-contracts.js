const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const context = fs.readFileSync(path.join(root, 'context.js'), 'utf8');
const music = fs.readFileSync(path.join(root, 'music.js'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'scheduler.js'), 'utf8');
const spotify = require('../music-spotify');
const llm = require('../llm');

assert.match(server, /function enqueueScheduledProgramStart\(/);
assert.match(server, /scheduler\.init\(broadcast,\s*enqueueScheduledProgramStart\)/);
assert.match(scheduler, /enqueueScheduledProgramStart from server\.js/);
assert.match(server, /function directMusicFailureResult\(/);
assert.match(server, /let directRequestFailed = false;/);
assert.match(server, /if \(!tracks\.length && !directRequestFailed\)/);
assert.match(server, /throw llmUnavailableError\(err, 'Program start'\)/);
assert.match(server, /throw llmUnavailableError\(err, 'Cold open'\)/);
assert.match(server, /function llmOptionsForPhase\(/);
assert.match(server, /function callRadioLlm\(/);
assert.match(server, /LLM_SUBPROCESS_CONCURRENCY/);
assert.match(server, /function normalizeMusicProvider\(/);
assert.match(server, /PROGRAM_START_QUICK_OPEN/);
assert.match(server, /function synthesizeQuickColdOpen\(/);
assert.match(server, /callRadioLlm\(prompt, 'program_start'\)/);
assert.match(server, /llmPhase: job\.musicRequest \? 'direct_cold_open' : 'cold_open'/);
assert.match(server, /provisionalColdOpenMatchesResolvedTrack/);
assert.match(server, /复用选歌阶段 cold_open/);
assert.match(server, /type: 'opening_generation'/);
assert.match(server, /continuationOnly: true/);
assert.match(server, /BRIDGE_LLM_ENABLED/);
assert.match(server, /fallbackBridgeResult/);
assert.match(server, /if \(autoStart\) \{/);
assert.match(server, /intent\.musicRequest = null;/);
assert.match(server, /function resetEmptyProgramState\(/);
assert.match(server, /if \(tracks\.length\) stationState\.lastProgramPayload = payload;/);
assert.match(server, /metrics: timing\.summary\(\{ firstMusicReady: true, quickOpen \}\)/);
assert.match(server, /quickOpen/);
assert.match(server, /app\.get\('\/api\/metrics'/);
assert.match(server, /cleanupTtsCache\(\)/);
assert.match(server, /warmupTts\(\)/);
assert.match(server, /musicProvider: normalizeMusicProvider\(musicProvider\)/);
assert.match(server, /function payloadMusicProvider\(/);
assert.match(server, /musicProvider: payloadMusicProvider\(job\.musicProvider\)/);
assert.match(server, /musicProvider: payloadMusicProvider\(intent\.musicProvider\)/);
assert.match(server, /getTrack\(query, \{ provider: options\.musicProvider \}\)/);

assert.match(context, /program_start：开播选歌，并为 play\[0\] 写一段可直接播出的完整 cold_open/);
assert.doesNotMatch(context, /Return only: title, play, openingLeadIn, reason/);
assert.doesNotMatch(context, /buildOpeningLeadInPrompt/);
assert.match(context, /2-4 cold_open segments/);
assert.match(context, /directRequest \? 6 : 12/);

assert.match(fs.readFileSync(path.join(root, 'llm.js'), 'utf8'), /provider === 'codex_cli'/);
const tts = fs.readFileSync(path.join(root, 'tts.js'), 'utf8');
assert.match(tts, /DJ_TTS_VOLUME_GAIN/);
assert.match(tts, /function applyWavVolumeGain\(/);
assert.match(tts, /:wavgain=v2:\$\{gain\.toFixed\(3\)\}/);
assert.match(tts, /readFloatLE/);
const previousFallbackProviders = process.env.LLM_FALLBACK_PROVIDERS;
process.env.LLM_FALLBACK_PROVIDERS = '';
assert.deepStrictEqual(llm._test.providerChain('codex_cli'), ['codex_cli']);
if (previousFallbackProviders === undefined) delete process.env.LLM_FALLBACK_PROVIDERS;
else process.env.LLM_FALLBACK_PROVIDERS = previousFallbackProviders;
assert.deepStrictEqual(llm._test.splitCliArgs('-c model_reasoning_effort=low -p radio'), ['-c', 'model_reasoning_effort=low', '-p', 'radio']);
assert.deepStrictEqual(
  llm._test.buildCodexArgs('/tmp/out.json', {
    model: 'fast-model',
    codexProfile: 'radio',
    codexConfigArgs: '-c model_reasoning_effort=low',
    codexIgnoreRules: false,
  }).slice(0, 7),
  ['exec', '-m', 'fast-model', '-p', 'radio', '-c', 'model_reasoning_effort=low']
);
assert.ok(llm._test.buildCodexArgs('/tmp/out.json', {}).includes('--ignore-rules'));

assert.match(server, /app\.get\('\/api\/session'/);
assert.match(server, /lastProgramPayload/);
assert.doesNotMatch(server, /api\/netease/);
assert.doesNotMatch(server, /netease-session/);

assert.match(server, /const startIndex = stationState\.tracks\.length;/);
assert.doesNotMatch(server, /const startIndex = Number\.isInteger\(job\.queueLength\)/);

assert.doesNotMatch(music, /music-netease/);
assert.doesNotMatch(music, /MUSIC_ENABLE_NETEASE/);
assert.match(music, /process\.env\.MUSIC_PROVIDER \|\| 'spotify'/);

assert.match(pwa, /function syncSessionState\(/);
assert.doesNotMatch(pwa, /id="spotifyProviderBtn"/);
assert.doesNotMatch(pwa, /id="neteaseLoginBtn"/);
assert.doesNotMatch(pwa, /id="neteaseLoginPanel"/);
assert.doesNotMatch(pwa, /provider-picker/);
assert.doesNotMatch(pwa, /data-provider="netease"/);
assert.doesNotMatch(pwa, /id="hostModeControl"/);
assert.doesNotMatch(pwa, /data-mode="quiet"/);
assert.doesNotMatch(pwa, /data-mode="story"/);
assert.doesNotMatch(pwa, /data-mode="companion"/);
assert.match(pwa, /claudio:music-provider/);
assert.match(pwa, /const musicProvider = 'spotify';/);
assert.match(pwa, /let activeProgramMusicProvider = '';/);
assert.match(pwa, /let pendingProgramMusicProvider = '';/);
assert.match(pwa, /let pendingProgramHandoff = null;/);
assert.match(pwa, /function inferMusicProviderFromTracks\(/);
assert.match(pwa, /function lockProgramMusicProvider\(/);
assert.match(pwa, /lockProgramMusicProvider\(msg\.musicProvider, msg\.tracks\)/);
assert.match(pwa, /function startProgramHandoff\(msg\)/);
assert.match(pwa, /speakSegmentSequence\(openingSegments, switchToNewProgram\)/);
assert.match(pwa, /bufferProgramHandoffMessage\(msg, 'tracksReady'\)/);
assert.match(pwa, /bufferProgramHandoffMessage\(msg, 'segmentReady'\)/);
assert.match(pwa, /const refillMusicProvider = normalizeMusicProvider\(activeProgramMusicProvider \|\| musicProvider\)/);
assert.doesNotMatch(pwa, /api\/netease/);
assert.doesNotMatch(pwa, /musicProviderControl/);
assert.match(pwa, /body: JSON\.stringify\(\{ message, djLanguage, musicProvider: requestMusicProvider, autoStart \}\)/);
assert.match(pwa, /musicProvider: refillMusicProvider/);
assert.match(pwa, /await syncSessionState\(\);/);
assert.match(pwa, /if \(!musicIsPlaying\(\) && !awaitingNextTrack\) return;/);
assert.match(pwa, /const queueWasEmpty = queue\.length === 0;/);
assert.match(pwa, /const voiceBusy = voiceChannelBusy\(\);/);
assert.match(pwa, /autoPlay && !voiceBusy/);
assert.match(pwa, /\(queueWasEmpty && playbackIsEmpty\(\)\)/);
assert.match(pwa, /function playNext\(reason = 'unknown', token = currentPlaybackToken\)/);
assert.match(pwa, /stale advance ignored/);
assert.match(pwa, /stale deferred start ignored/);
assert.match(pwa, /playNext\('spotify-timer', token\)/);
assert.match(pwa, /playNext\('spotify-state', token\)/);
assert.match(pwa, /playNext\('html-ended', token\)/);
assert.match(pwa, /else if \(awaitingNextTrack\) \{/);
assert.match(pwa, /REFILL_BACKOFF_MS \+ 250/);

assert.strictEqual(typeof spotify._test.cacheMaxEntries(), 'number');
assert.ok(spotify._test.cacheMaxEntries() >= 0);

console.log('radio contracts ok');
