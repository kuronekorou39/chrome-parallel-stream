// multiview.js の、小さな計算の関数を検証する。
//   - clampVol                       … 音量を 0〜1 に収める
//   - dmkParseColor / dmkBlendColor  … 弾幕の色(コメントの色を白と混ぜる)
//   - packVolumeRows                 … 「音量順」の配置で、枠を行に詰める
// multiview.js はブラウザ専用なので、関数と定数の定義だけをソースから抜き出して評価する
// (やり方は cmpVersion.test.mjs と同じ)。
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

function constSource(name) {
  const m = src.match(new RegExp(`^const ${name} = [\\s\\S]*?;`, 'm'));
  if (!m) throw new Error(`${name} が見つかりません`);
  return m[0];
}

const f = new Function(
  [
    constSource('MASTER_VOLUME_DEFAULT'),
    constSource('VOL_LAYOUT_ASPECT'),
    ...['clampVol', 'dmkParseColor', 'dmkBlendColor', 'packVolumeRows'].map(functionSource),
    'return { clampVol, dmkParseColor, dmkBlendColor, packVolumeRows, MASTER_VOLUME_DEFAULT, VOL_LAYOUT_ASPECT };',
  ].join('\n')
)();

test('clampVol: 0〜1 に収める', () => {
  assert.equal(f.clampVol(0.5), 0.5);
  assert.equal(f.clampVol('0.25'), 0.25);
  assert.equal(f.clampVol(0), 0);
  assert.equal(f.clampVol(2), 1);
  assert.equal(f.clampVol(-1), 0);
});

test('clampVol: 数として読めない値は既定の音量にする(0 にはしない)', () => {
  assert.equal(f.clampVol(undefined), f.MASTER_VOLUME_DEFAULT);
  assert.equal(f.clampVol('abc'), f.MASTER_VOLUME_DEFAULT);
  assert.equal(f.clampVol(NaN), f.MASTER_VOLUME_DEFAULT);
  assert.ok(f.MASTER_VOLUME_DEFAULT > 0);
});

test('dmkParseColor: #rrggbb / #rgb / rgb() / rgba() を読む', () => {
  assert.deepEqual(f.dmkParseColor('#ff0000'), [255, 0, 0]);
  assert.deepEqual(f.dmkParseColor('#0F0'), [0, 255, 0]);
  assert.deepEqual(f.dmkParseColor(' rgb(1, 2, 3) '), [1, 2, 3]);
  assert.deepEqual(f.dmkParseColor('rgba(10,20,30,0.5)'), [10, 20, 30]);
});

test('dmkParseColor: 読めない色は null', () => {
  assert.equal(f.dmkParseColor(''), null);
  assert.equal(f.dmkParseColor(null), null);
  assert.equal(f.dmkParseColor('red'), null);
  assert.equal(f.dmkParseColor('#ff00'), null);
  assert.equal(f.dmkParseColor('rgb(1,2)'), null);
});

test('dmkBlendColor: 強さ 0 で白、100 で元の色、間は混ぜる', () => {
  assert.equal(f.dmkBlendColor('#ff0000', 0), 'rgb(255,255,255)');
  assert.equal(f.dmkBlendColor('#ff0000', 100), 'rgb(255,0,0)');
  assert.equal(f.dmkBlendColor('#ff0000', 50), 'rgb(255,128,128)');
  assert.equal(f.dmkBlendColor('#ff0000', 300), 'rgb(255,0,0)');
  assert.equal(f.dmkBlendColor('#ff0000', -5), 'rgb(255,255,255)');
});

test('dmkBlendColor: 色が読めなければ白', () => {
  assert.equal(f.dmkBlendColor('red', 100), '#fff');
  assert.equal(f.dmkBlendColor(undefined, 50), '#fff');
});

test('packVolumeRows: 幅に入るだけ並べ、あふれたら次の行へ送る', () => {
  const base = 90;
  const gap = 10;
  const w = base * f.VOL_LAYOUT_ASPECT; // 比率 1 の枠 1 つの幅
  const items = [{ r: 1 }, { r: 1 }, { r: 1 }];
  const two = f.packVolumeRows(items, 2 * w + gap, gap, base); // ちょうど 2 つ入る幅
  assert.deepEqual(two.rows.map((row) => row.items.length), [2, 1]);
  assert.equal(two.rows[0].w, 2 * w + gap);
  assert.equal(two.totalH, base + gap + base);

  const one = f.packVolumeRows(items, 3 * w + 2 * gap, gap, base); // 3 つとも入る幅
  assert.deepEqual(one.rows.map((row) => row.items.length), [3]);
  assert.equal(one.totalH, base);
});

test('packVolumeRows: 行の高さは、その行でいちばん大きい枠に合わせる', () => {
  const base = 90;
  const { rows, totalH } = f.packVolumeRows([{ r: 2 }, { r: 1 }], 10000, 10, base);
  assert.equal(rows.length, 1);
  assert.equal(totalH, base * 2);
});

test('packVolumeRows: 幅より大きい枠でも 1 行に 1 つは置く。空なら行なし', () => {
  const big = f.packVolumeRows([{ r: 1 }, { r: 1 }], 1, 10, 90);
  assert.deepEqual(big.rows.map((row) => row.items.length), [1, 1]);
  assert.deepEqual(f.packVolumeRows([], 1000, 10, 90), { rows: [], totalH: 0 });
});
