// multiview.js の cmpVersion(a, b) を検証する。
// multiview.js は window/document 前提のブラウザ専用スクリプトで、まるごと import すると
// トップレベルの `window.matchMedia(...)` 等で即座に落ちる。そのため関数定義部分だけを
// ソースから抜き出して評価する(実ファイルの現在のコードをそのまま実行して検証するため)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const multiviewSrc = readFileSync(join(ROOT, 'multiview.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} が見つかりません`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let end = braceStart;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return new Function(`return (${src.slice(start, end + 1)})`)();
}

const cmpVersion = extractFunction(multiviewSrc, 'cmpVersion');

test('cmpVersion: 同じ版は 0', () => {
  assert.equal(cmpVersion('1.0.0', '1.0.0'), 0);
});

test('cmpVersion: 新しい方が大きい／古い方が小さい', () => {
  assert.ok(cmpVersion('1.0.1', '1.0.0') > 0);
  assert.ok(cmpVersion('1.0.0', '1.0.1') < 0);
  assert.ok(cmpVersion('2.0.0', '1.9.9') > 0);
});

test('cmpVersion: 桁数が揃っていなくても比較できる', () => {
  assert.equal(cmpVersion('1.2', '1.2.0'), 0);
  assert.ok(cmpVersion('1.2.1', '1.2') > 0);
});
