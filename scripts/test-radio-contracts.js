const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
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

assert.match(fs.readFileSync(path.join(root, 'llm.js'), 'utf8'), /provider === 'codex_cli'/);
const previousFallbackProviders = process.env.LLM_FALLBACK_PROVIDERS;
process.env.LLM_FALLBACK_PROVIDERS = '';
assert.deepStrictEqual(llm._test.providerChain('codex_cli'), ['codex_cli']);
if (previousFallbackProviders === undefined) delete process.env.LLM_FALLBACK_PROVIDERS;
else process.env.LLM_FALLBACK_PROVIDERS = previousFallbackProviders;

assert.match(server, /app\.get\('\/api\/session'/);
assert.match(server, /lastProgramPayload/);

assert.match(server, /const startIndex = stationState\.tracks\.length;/);
assert.doesNotMatch(server, /const startIndex = Number\.isInteger\(job\.queueLength\)/);

assert.match(pwa, /function syncSessionState\(/);
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

assert.strictEqual(typeof spotify._test.cacheMaxEntries(), 'number');
assert.ok(spotify._test.cacheMaxEntries() >= 0);

console.log('radio contracts ok');
