// multiview.js の URL まわりの関数を検証する。
//   - isAllowedFrameUrl … 枠として読み込んでよい URL か(javascript: 等を弾く。安全に関わる)
//   - youtubeVideoIdOf / twitchChannelOf / kickWatchChannel … URL から動画 ID・チャンネル名を取る
//   - toLightUrl / toTwitchChatUrl / toYouTubeChatUrl … 埋め込み用の URL へ変換する
//   - channelParts / siteOf / labelFor … 一覧に出す表示用の分解
// multiview.js はブラウザ専用なので、関数と定数の定義だけをソースから抜き出して評価する
// (やり方は cmpVersion.test.mjs と同じ。互いに呼び合うものはまとめて評価する)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'multiview.js'), 'utf8');

function functionSource(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} が見つかりません`);
  let depth = 0;
  let end = src.indexOf('{', start);
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, end + 1);
}

// トップレベルの `const NAME = …;` を抜き出す(配列が複数行にまたがるものも含む)。
function constSource(name) {
  const m = src.match(new RegExp(`^const ${name} = [\\s\\S]*?;`, 'm'));
  if (!m) throw new Error(`${name} が見つかりません`);
  return m[0];
}

// 埋め込み用 URL の parent / embed_domain には、このページのホスト名が入る。
const HOST = 'pages.example';
const SOURCES = [
  constSource('EMBEDDABLE_HOSTS'),
  constSource('TWITCH_NON_CHANNEL'),
  constSource('KICK_NON_CHANNEL'),
  ...[
    'isEmbeddableHost', 'isAllowedFrameUrl', 'hostOf', 'kickChannelOf', 'kickWatchChannel',
    'youtubeVideoIdOf', 'toYouTubeChatUrl', 'twitchChannelOf', 'toTwitchChatUrl', 'toLightUrl',
    'labelFor', 'channelParts', 'siteOf',
  ].map(functionSource),
].join('\n');
const f = new Function(
  'location',
  `${SOURCES}\nreturn { isAllowedFrameUrl, kickWatchChannel, youtubeVideoIdOf, toYouTubeChatUrl,
    twitchChannelOf, toTwitchChatUrl, toLightUrl, labelFor, channelParts, siteOf };`
)({ hostname: HOST });

test('isAllowedFrameUrl: 対応サイトの http(s) だけ通す', () => {
  assert.equal(f.isAllowedFrameUrl('https://www.twitch.tv/foo'), true);
  assert.equal(f.isAllowedFrameUrl('https://twitch.tv/foo'), true);
  assert.equal(f.isAllowedFrameUrl('http://kick.com/foo'), true);
  assert.equal(f.isAllowedFrameUrl('https://youtu.be/abc'), true);
  assert.equal(f.isAllowedFrameUrl('https://WWW.YOUTUBE.COM/watch?v=abc'), true);
  assert.equal(f.isAllowedFrameUrl('https://www.mellow-fan.com/live/abc'), true);
});

test('isAllowedFrameUrl: http(s) 以外のスキームは弾く', () => {
  assert.equal(f.isAllowedFrameUrl('javascript:alert(1)'), false);
  assert.equal(f.isAllowedFrameUrl('data:text/html,<p>x</p>'), false);
  assert.equal(f.isAllowedFrameUrl('file:///C:/x.html'), false);
  assert.equal(f.isAllowedFrameUrl('ftp://twitch.tv/foo'), false);
});

test('isAllowedFrameUrl: 名前が似ているだけのホストは弾く', () => {
  assert.equal(f.isAllowedFrameUrl('https://eviltwitch.tv/foo'), false);
  assert.equal(f.isAllowedFrameUrl('https://twitch.tv.evil.example/foo'), false);
  assert.equal(f.isAllowedFrameUrl('https://example.com/?u=twitch.tv'), false);
  assert.equal(f.isAllowedFrameUrl('https://example.com/twitch.tv'), false);
});

test('isAllowedFrameUrl: URL として読めないものは弾く', () => {
  assert.equal(f.isAllowedFrameUrl(''), false);
  assert.equal(f.isAllowedFrameUrl('twitch.tv/foo'), false);
  assert.equal(f.isAllowedFrameUrl(null), false);
});

test('youtubeVideoIdOf: 各形式の URL から動画 ID を取る', () => {
  assert.equal(f.youtubeVideoIdOf('https://www.youtube.com/watch?v=abc123'), 'abc123');
  assert.equal(f.youtubeVideoIdOf('https://youtu.be/abc123?t=10'), 'abc123');
  assert.equal(f.youtubeVideoIdOf('https://www.youtube.com/live/abc123'), 'abc123');
  assert.equal(f.youtubeVideoIdOf('https://www.youtube.com/shorts/abc123'), 'abc123');
  assert.equal(f.youtubeVideoIdOf('https://www.youtube.com/embed/abc123'), 'abc123');
});

test('youtubeVideoIdOf: 動画のページでなければ null', () => {
  assert.equal(f.youtubeVideoIdOf('https://www.youtube.com/'), null);
  assert.equal(f.youtubeVideoIdOf('https://www.youtube.com/@someone'), null);
  assert.equal(f.youtubeVideoIdOf('https://www.youtube.com/watch'), null);
  assert.equal(f.youtubeVideoIdOf('https://www.twitch.tv/watch?v=abc123'), null);
  assert.equal(f.youtubeVideoIdOf('not a url'), null);
});

test('twitchChannelOf: 配信ページのときだけチャンネル名を返す', () => {
  assert.equal(f.twitchChannelOf('https://www.twitch.tv/foo'), 'foo');
  assert.equal(f.twitchChannelOf('https://www.twitch.tv/foo/clip/bar'), 'foo');
  assert.equal(f.twitchChannelOf('https://www.twitch.tv/'), null);
  assert.equal(f.twitchChannelOf('https://www.twitch.tv/videos/123'), null);
  assert.equal(f.twitchChannelOf('https://www.twitch.tv/directory/game/x'), null);
  assert.equal(f.twitchChannelOf('https://player.twitch.tv/?channel=foo'), null);
  assert.equal(f.twitchChannelOf('https://kick.com/foo'), null);
  assert.equal(f.twitchChannelOf('not a url'), null);
});

test('toLightUrl: Kick の配信ページだけ公式プレイヤーにする', () => {
  assert.equal(f.toLightUrl('https://kick.com/foo'), 'https://player.kick.com/foo?autoplay=true&muted=true');
  assert.equal(f.toLightUrl('https://kick.com/'), null);
  assert.equal(f.toLightUrl('https://kick.com/browse'), null);
});

test('kickWatchChannel: 配信ページのときだけチャンネル名を返す', () => {
  assert.equal(f.kickWatchChannel('https://kick.com/foo'), 'foo');
  assert.equal(f.kickWatchChannel('https://kick.com/'), '');
  assert.equal(f.kickWatchChannel('https://kick.com/browse'), '');
  assert.equal(f.kickWatchChannel('https://kick.com/Categories/x'), '');
  assert.equal(f.kickWatchChannel('https://www.twitch.tv/foo'), '');
  assert.equal(f.kickWatchChannel('not a url'), '');
});

test('toLightUrl: YouTube は埋め込みプレイヤーへ。開始位置は引き継ぐ', () => {
  const base = 'https://www.youtube.com/embed/abc123?autoplay=1&playsinline=1&mute=1&enablejsapi=1&widgetid=1';
  assert.equal(f.toLightUrl('https://www.youtube.com/watch?v=abc123'), base);
  assert.equal(f.toLightUrl('https://youtu.be/abc123'), base);
  assert.equal(f.toLightUrl('https://www.youtube.com/watch?v=abc123&t=6916s'), base + '&start=6916');
  assert.equal(f.toLightUrl('https://www.youtube.com/watch?v=abc123&start=30'), base + '&start=30');
  assert.equal(f.toLightUrl('https://www.youtube.com/@someone'), null);
});

test('toLightUrl: Twitch はライブも VOD も埋め込みプレイヤーへ', () => {
  const tail = '&autoplay=true&muted=true&parent=' + HOST;
  assert.equal(f.toLightUrl('https://www.twitch.tv/foo'), 'https://player.twitch.tv/?channel=foo' + tail);
  assert.equal(f.toLightUrl('https://www.twitch.tv/videos/123'), 'https://player.twitch.tv/?video=123' + tail);
  assert.equal(f.toLightUrl('https://www.twitch.tv/'), null);
  assert.equal(f.toLightUrl('https://www.twitch.tv/directory'), null);
  assert.equal(f.toLightUrl('https://player.twitch.tv/?channel=foo'), null);
});

test('toLightUrl: mellow-fan(旧 OPENREC)は埋め込みへ。それ以外は null', () => {
  assert.equal(f.toLightUrl('https://www.openrec.tv/live/xyz'), 'https://www.mellow-fan.com/embed/xyz');
  assert.equal(f.toLightUrl('https://www.mellow-fan.com/movie/xyz'), 'https://www.mellow-fan.com/embed/xyz');
  assert.equal(f.toLightUrl('https://www.mellow-fan.com/'), null);
  assert.equal(f.toLightUrl('not a url'), null);
});

test('チャットの URL: このページのホスト名を埋め込み元として渡す', () => {
  assert.equal(
    f.toTwitchChatUrl('https://www.twitch.tv/foo'),
    'https://www.twitch.tv/embed/foo/chat?darkpopout&parent=' + HOST
  );
  assert.equal(f.toTwitchChatUrl('https://www.twitch.tv/videos/123'), null);
  assert.equal(
    f.toYouTubeChatUrl('https://www.youtube.com/watch?v=abc123'),
    'https://www.youtube.com/live_chat?v=abc123&embed_domain=' + HOST + '&dark_theme=1'
  );
  assert.equal(f.toYouTubeChatUrl('https://www.youtube.com/@someone'), null);
});

test('channelParts: サイト部分と、チャンネル名や動画 ID に分ける', () => {
  assert.deepEqual(f.channelParts('https://www.twitch.tv/jun_channel'), { site: 'twitch.tv/', name: 'jun_channel' });
  assert.deepEqual(f.channelParts('https://www.youtube.com/watch?v=ABcd'), { site: 'youtube.com/', name: 'ABcd' });
  assert.deepEqual(f.channelParts('https://youtu.be/ABcd'), { site: 'youtu.be/', name: 'ABcd' });
  assert.deepEqual(f.channelParts('https://www.youtube.com/live/ABcd'), { site: 'youtube.com/', name: 'ABcd' });
  assert.deepEqual(f.channelParts('https://www.openrec.tv/live/xyz'), { site: 'openrec.tv/', name: 'xyz' });
  assert.deepEqual(f.channelParts('https://player.twitch.tv/?channel=foo'), { site: 'player.twitch.tv/', name: 'foo' });
  assert.deepEqual(f.channelParts('https://kick.com/foo'), { site: 'kick.com/', name: 'foo' });
  assert.deepEqual(f.channelParts('https://www.twitch.tv/'), { site: 'twitch.tv', name: '' });
  assert.deepEqual(f.channelParts('not a url'), { site: '', name: 'not a url' });
});

test('siteOf: URL からサイトを判定する', () => {
  assert.equal(f.siteOf('https://www.twitch.tv/foo').name, 'Twitch');
  assert.equal(f.siteOf('https://player.twitch.tv/?channel=foo').name, 'Twitch');
  assert.equal(f.siteOf('https://youtu.be/abc').name, 'YouTube');
  assert.equal(f.siteOf('https://kick.com/foo').name, 'Kick');
  assert.equal(f.siteOf('https://www.openrec.tv/live/x').name, 'mellow-fan');
  assert.equal(f.siteOf('https://example.com/').name, 'example.com');
  assert.equal(f.siteOf('not a url').name, 'その他');
});

test('labelFor: www. を落としたホスト名とパス。読めなければそのまま返す', () => {
  assert.equal(f.labelFor('https://www.twitch.tv/foo'), 'twitch.tv/foo');
  assert.equal(f.labelFor('https://kick.com/foo?x=1'), 'kick.com/foo');
  assert.equal(f.labelFor('not a url'), 'not a url');
});
