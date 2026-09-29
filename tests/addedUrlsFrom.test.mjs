// multiview.js の addedUrlsFrom(search) を検証する(別サイトのリンクから渡された配信 URL の取り出し)。
// multiview.js はブラウザ専用スクリプトでまるごと import できないため、必要な定義だけを
// ソースから抜き出して評価する(cmpVersion.test.mjs と同じやり方)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const multiviewSrc = readFileSync(join(ROOT, 'multiview.js'), 'utf8');

function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} が見つかりません`);
  let depth = 0;
  let end = src.indexOf('{', start);
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) break;
  }
  return src.slice(start, end + 1);
}

function constSource(src, name) {
  const found = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!found) throw new Error(`${name} が見つかりません`);
  return found[0];
}

const addedUrlsFrom = new Function([
  constSource(multiviewSrc, 'MAX_WINDOWS'),
  constSource(multiviewSrc, 'EMBEDDABLE_HOSTS'),
  functionSource(multiviewSrc, 'isEmbeddableHost'),
  functionSource(multiviewSrc, 'isAllowedFrameUrl'),
  functionSource(multiviewSrc, 'addedUrlsFrom'),
  'return addedUrlsFrom;',
].join('\n'))();

const query = (urls) => '?' + new URLSearchParams(urls.map((u) => ['add', u]));

test('addedUrlsFrom: 渡された順に取り出す', () => {
  const urls = ['https://www.twitch.tv/someone', 'https://www.youtube.com/watch?v=abc&t=10s', 'https://kick.com/someone'];
  assert.deepEqual(addedUrlsFrom(query(urls)), urls);
});

test('addedUrlsFrom: add が無ければ空', () => {
  assert.deepEqual(addedUrlsFrom(''), []);
  assert.deepEqual(addedUrlsFrom('?dev=1'), []);
});

test('addedUrlsFrom: 枠に表示できない URL は捨てる', () => {
  const ok = 'https://www.twitch.tv/someone';
  assert.deepEqual(addedUrlsFrom(query(['https://example.com/', 'javascript:alert(1)', 'twitch.tv/no-scheme', '', ok])), [ok]);
});

test('addedUrlsFrom: 重複は1つにまとめる', () => {
  const a = 'https://www.twitch.tv/a';
  const b = 'https://www.twitch.tv/b';
  assert.deepEqual(addedUrlsFrom(query([a, b, a])), [a, b]);
});

test('addedUrlsFrom: 枠数の上限で切る', () => {
  const urls = Array.from({ length: 25 }, (_, i) => `https://www.twitch.tv/ch${i}`);
  assert.deepEqual(addedUrlsFrom(query(urls)), urls.slice(0, 20));
});
