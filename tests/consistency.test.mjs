// 別々のファイルに置くしかない値が、食い違っていないことを検証する。
// 枠内の MAIN world スクリプトは配信サイトのページと同じ世界で動く。共通ファイルにして global で
// 共有すると、その global がサイト側から見えてしまうので、値は各ファイルに持ち、ここで一致を保証する。
import { test } from 'node:test';
import { uiScripts, uiSource } from './ui-source.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = 'js/*.js';
const read = (name) => (name === UI ? uiSource() : readFileSync(join(ROOT, name), 'utf8'));
const capture = (file, re) => {
  const m = read(file).match(re);
  assert.ok(m, `${file} に ${re} がありません`);
  return m[1];
};

const PAGES_ORIGIN = 'https://kuronekorou39.github.io';
const HOSTED_URL = `${PAGES_ORIGIN}/chrome-parallel-stream/multiview.html`;

test('枠内スクリプトは、すべて同じ公開元だけを自分の枠とみなす', () => {
  for (const file of ['stream-control.js', 'twitch-keepalive.js', 'keepalive-visibility.js', 'twitch-chat-ime.js']) {
    const src = read(file);
    assert.ok(src.includes('ancestorOrigins'), `${file} に枠の判定がありません`);
    assert.ok(src.includes(`'${PAGES_ORIGIN}'`), `${file} の公開元が違います`);
  }
});

test('ポップアップと橋渡しが開くページの URL は同じ', () => {
  assert.equal(capture('popup.js', /MULTIVIEW_URL = '([^']+)'/), HOSTED_URL);
  assert.equal(capture('ext-bridge.js', /HOSTED_URL = '([^']+)'/), HOSTED_URL);
});

test('枠とやり取りするメッセージの目印は全ファイルで同じ', () => {
  const magic = capture(UI, /const MAGIC = '([^']+)'/);
  assert.equal(capture('stream-control.js', /const MAGIC = '([^']+)'/), magic);
  assert.equal(capture('twitch-keepalive.js', /const MAGIC = '([^']+)'/), magic);
  assert.ok(read('keepalive-visibility.js').includes(`{ ${magic}: true,`));
});

test('遅延の上限は、ページと枠の中で同じ', () => {
  assert.equal(
    capture(UI, /const DELAY_MAX_SEC = (\d+)/),
    capture('twitch-keepalive.js', /const DELAY_MAX_SEC = (\d+)/)
  );
});

test('枠の最小サイズと、浮動パネルの重なり順は JS と CSS で同じ', () => {
  assert.equal(capture(UI, /^const MIN_W = (\d+)/m), capture('multiview.css', /min-width: (\d+)px; min-height: \d+px;/));
  assert.equal(capture(UI, /^const MIN_H = (\d+)/m), capture('multiview.css', /min-width: \d+px; min-height: (\d+)px;/));
  assert.equal(capture(UI, /^let panelZ = (\d+)/m), capture('multiview.css', /--z-panel: (\d+);/));
});

test('js/ のファイルはすべて読み込まれ、起動処理(main.js)が最後', () => {
  const scripts = uiScripts();
  const files = readdirSync(join(ROOT, 'js')).map((f) => 'js/' + f);
  assert.deepEqual([...scripts].sort(), files.sort());
  assert.equal(new Set(scripts).size, scripts.length);
  assert.equal(scripts[scripts.length - 1], 'js/main.js');
});

test('js/ のトップレベルの名前は重複せず、どれもどこかで使われている', () => {
  const src = uiSource();
  const names = [...src.matchAll(/^(?:async )?function (\w+)|^(?:const|let) (\w+)/gm)].map((m) => m[1] || m[2]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const unused = names.filter((n) => (code.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length < 2);
  assert.deepEqual(unused, []);
});
