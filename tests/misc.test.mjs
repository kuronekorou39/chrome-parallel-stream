// multiview.js の、小さな計算の関数を検証する。
//   - clampVol                       … 音量を 0〜1 に収める
//   - dmkParseColor / dmkBlendColor  … 弾幕の色(コメントの色を白と混ぜる)
//   - packVolumeRows                 … 「音量順」の配置で、枠を行に詰める
// multiview.js はブラウザ専用なので、関数と定数の定義だけをソースから抜き出して評価する
// (やり方は cmpVersion.test.mjs と同じ)。
import { test } from 'node:test';
import { uiSource } from './ui-source.mjs';
import assert from 'node:assert/strict';

const src = uiSource();

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
    constSource('AUTO_LAYOUT_MODES'),
    ...['clampVol', 'dmkParseColor', 'dmkBlendColor', 'packVolumeRows', 'tileGrid', 'autoLayoutModeOf', 'rectResized', 'panelOverlapCost', 'pickPanelPos', 'volIconName', 'nextMuteVolume', 'layoutAnimFrom'].map(functionSource),
    'return { clampVol, dmkParseColor, dmkBlendColor, packVolumeRows, tileGrid, autoLayoutModeOf, rectResized, panelOverlapCost, pickPanelPos, volIconName, nextMuteVolume, layoutAnimFrom, MASTER_VOLUME_DEFAULT, VOL_LAYOUT_ASPECT };',
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

test('packVolumeRows: 高さの下限より小さい枠は、下限の大きさで詰める', () => {
  const { rows, totalH } = f.packVolumeRows([{ r: 1 }, { r: 0.2 }], 10000, 10, 300, 240);
  assert.equal(totalH, 300);
  assert.equal(rows[0].w, 300 * f.VOL_LAYOUT_ASPECT + 10 + 240 * f.VOL_LAYOUT_ASPECT);
});

test('panelOverlapCost: 重なった面積 × 重みを足す。接しているだけなら 0', () => {
  const r = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(f.panelOverlapCost(r, [{ x: 5, y: 5, w: 10, h: 10, weight: 2 }]), 50);
  assert.equal(f.panelOverlapCost(r, [{ x: 10, y: 0, w: 10, h: 10, weight: 1 }]), 0);
});

test('pickPanelPos: 何も無ければ中央に置く', () => {
  assert.deepEqual(
    (({ x, y, cost }) => ({ x, y, cost }))(f.pickPanelPos(100, 100, 1000, 500, [], 10)),
    { x: 450, y: 200, cost: 0 }
  );
});

test('pickPanelPos: 空きがあれば、枠に被らない場所へ置く', () => {
  const left = { x: 0, y: 0, w: 700, h: 500, weight: 1 };
  const p = f.pickPanelPos(200, 100, 1000, 500, [left], 10);
  assert.equal(p.cost, 0);
  assert.ok(p.x >= 710);
});

test('pickPanelPos: 空きが無ければ、重みの小さい枠の上を選ぶ', () => {
  const loud = { x: 0, y: 0, w: 500, h: 500, weight: 1.25 };
  const quiet = { x: 500, y: 0, w: 500, h: 500, weight: 0.3 };
  const p = f.pickPanelPos(200, 100, 1000, 500, [loud, quiet], 10);
  assert.ok(p.x >= 500);
});

test('pickPanelPos: 画面より大きいパネルでも位置を返す', () => {
  const p = f.pickPanelPos(2000, 1000, 1000, 500, [], 10);
  assert.deepEqual([p.x, p.y], [10, 10]);
});

test('volIconName: 0 は専用、それ以外は大きさで 3 段階', () => {
  assert.equal(f.volIconName(0), 'vol-off');
  assert.equal(f.volIconName(0.01), 'vol-low');
  assert.equal(f.volIconName(0.33), 'vol-low');
  assert.equal(f.volIconName(0.34), 'vol-mid');
  assert.equal(f.volIconName(0.66), 'vol-mid');
  assert.equal(f.volIconName(0.67), 'vol-high');
  assert.equal(f.volIconName(1), 'vol-high');
});

test('nextMuteVolume: 鳴っていれば 0 にして音量を覚え、次で元へ戻す', () => {
  const muted = f.nextMuteVolume(0.8, null, 0.5);
  assert.deepEqual(muted, { vol: 0, remembered: 0.8 });
  assert.deepEqual(f.nextMuteVolume(muted.vol, muted.remembered, 0.5), { vol: 0.8, remembered: null });
});

test('nextMuteVolume: つまみで 0 にした後は既定の音量にする', () => {
  assert.deepEqual(f.nextMuteVolume(0, null, 0.5), { vol: 0.5, remembered: null });
});

test('layoutAnimFrom: 元の位置と大きさに見える transform を返す', () => {
  const from = { left: 10, top: 20, width: 100, height: 50 };
  const to = { left: 110, top: 70, width: 200, height: 100 };
  assert.equal(f.layoutAnimFrom(from, to), 'translate(-100px, -50px) scale(0.5, 0.5)');
});

test('layoutAnimFrom: 動いていない枠や、大きさの無い枠はアニメーションしない', () => {
  const r = { left: 10, top: 20, width: 100, height: 50 };
  assert.equal(f.layoutAnimFrom(r, { ...r }), null);
  assert.equal(f.layoutAnimFrom(r, { ...r, left: 10.5 }), null);
  assert.equal(f.layoutAnimFrom(r, { ...r, width: 0 }), null);
});

test('tileGrid: 横長の画面は横に、縦長の画面は縦に並べる', () => {
  assert.deepEqual(f.tileGrid(4, 1920, 1080, 4), { cols: 2, rows: 2 });
  assert.deepEqual(f.tileGrid(2, 1920, 400, 4), { cols: 2, rows: 1 });
  assert.deepEqual(f.tileGrid(3, 400, 1200, 4), { cols: 1, rows: 3 });
});

test('tileGrid: 画面が小さすぎても、全枠が入る行列を返す', () => {
  const { cols, rows } = f.tileGrid(5, 0, 0, 4);
  assert.ok(cols * rows >= 5);
});

test('autoLayoutModeOf: 知らない値はオフにする', () => {
  assert.equal(f.autoLayoutModeOf('tile'), 'tile');
  assert.equal(f.autoLayoutModeOf('volume'), 'volume');
  assert.equal(f.autoLayoutModeOf('snap'), 'off');
  assert.equal(f.autoLayoutModeOf(undefined), 'off');
});

test('rectResized: 大きさが変わったときだけ true(移動だけなら false)', () => {
  const r = { x: 1, y: 2, w: 3, h: 4 };
  assert.equal(f.rectResized(r, { ...r }), false);
  assert.equal(f.rectResized(r, { ...r, x: 9, y: 9 }), false);
  assert.equal(f.rectResized(r, { ...r, w: 9 }), true);
  assert.equal(f.rectResized(r, { ...r, h: 9 }), true);
});
