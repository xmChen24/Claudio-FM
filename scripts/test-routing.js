const assert = require('assert');
const { route } = require('../router');
const spotify = require('../music-spotify');

function musicRequest(input) {
  return route(input).musicRequest || null;
}

function assertNoDirectMusicRequest(input, userIntent = 'vibe_request') {
  const routed = route(input);
  assert.strictEqual(routed.mode, 'music', input);
  assert.strictEqual(routed.userIntent, userIntent, input);
  assert.strictEqual(routed.musicRequest, null, input);
}

assertNoDirectMusicRequest('More like this: keep the next set close to Archie, Marry Me - Alvvays, but avoid repeating the same artist');
assertNoDirectMusicRequest("It's 14:21 on Wednesday, June 3, 2026 (America/Los_Angeles). You're on air - open the station. Pick whatever fits the moment");

assert.deepStrictEqual(musicRequest('播放周杰伦的晴天'), {
  kind: 'track',
  query: '晴天 - 周杰伦',
  title: '晴天',
  artist: '周杰伦',
  userIntent: 'exact_track_request',
});

assert.deepStrictEqual(musicRequest('可以播放周杰伦的晴天'), {
  kind: 'track',
  query: '晴天 - 周杰伦',
  title: '晴天',
  artist: '周杰伦',
  userIntent: 'exact_track_request',
});

assert.deepStrictEqual(musicRequest('播放晴天'), {
  kind: 'unknown',
  query: '晴天',
  title: '晴天',
  prefer: 'track',
  userIntent: 'direct_music_request',
});

assert.deepStrictEqual(musicRequest('play HUMBLE by Kendrick Lamar'), {
  kind: 'track',
  query: 'HUMBLE - Kendrick Lamar',
  title: 'HUMBLE',
  artist: 'Kendrick Lamar',
  userIntent: 'exact_track_request',
});

assert.deepStrictEqual(musicRequest('Archie, Marry Me - Alvvays'), {
  kind: 'track',
  query: 'Archie, Marry Me - Alvvays',
  title: 'Archie, Marry Me',
  artist: 'Alvvays',
  userIntent: 'exact_track_request',
});

assert.deepStrictEqual(musicRequest('Drake'), {
  kind: 'unknown',
  query: 'Drake',
  userIntent: 'direct_music_request',
});

assert.deepStrictEqual(musicRequest('play Drake songs'), {
  kind: 'artist',
  query: 'Drake',
  artist: 'Drake',
  userIntent: 'artist_request',
});

assert.deepStrictEqual(musicRequest('播放艾志恒的歌曲'), {
  kind: 'artist',
  query: '艾志恒',
  artist: '艾志恒',
  userIntent: 'artist_request',
});

assert.deepStrictEqual(musicRequest('play艾志恒'), {
  kind: 'unknown',
  query: '艾志恒',
  title: '艾志恒',
  prefer: 'track',
  userIntent: 'direct_music_request',
});

assert.ok(
  spotify._test.normalizeSearchText('艾志恆Asen').includes(spotify._test.normalizeSearchText('艾志恒')),
  'traditional artist name should match simplified request'
);

const badMatch = spotify._test.chooseBestTrack([
  {
    id: '1',
    uri: 'spotify:track:1',
    name: 'In A Sentimental Mood',
    artists: [{ name: 'Duke Ellington' }, { name: 'John Coltrane' }],
    album: { name: 'Duke Ellington & John Coltrane', images: [] },
    duration_ms: 300000,
    external_urls: { spotify: 'https://example.com/1' },
  },
], { title: 'a sen', artist: '', query: 'a sen' });
assert.strictEqual(badMatch, null);

const cjkMatch = spotify._test.chooseBestTrack([
  {
    id: '2',
    uri: 'spotify:track:2',
    name: '晴天',
    artists: [{ name: '周杰伦' }],
    album: { name: '叶惠美', images: [] },
    duration_ms: 269000,
    external_urls: { spotify: 'https://example.com/2' },
  },
], { title: '晴天', artist: '周杰伦', query: '晴天 - 周杰伦' });
assert.ok(cjkMatch);
assert.strictEqual(cjkMatch.title, '晴天');

console.log('routing and music matching tests ok');
