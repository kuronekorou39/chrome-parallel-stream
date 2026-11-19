// 「音で合わせる」の計算部分(multiview.js)を検証する。
//   - audioLag(a, b, rate, maxLagSec) … 2 つの音のずれを測る(内部で fftInPlace を使う)
//   - syncOffsets(n, edges)          … 枠どうしのずれから、枠ごとの遅れを出す
//   - syncDelays(cur, off, max)      … 遅れから、各枠に付ける遅延を出す
// multiview.js はブラウザ専用なので、関数定義だけをソースから抜き出して評価する
// (やり方は cmpVersion.test.mjs と同じ。互いに呼び合う関数はまとめて評価する)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'multiview.js'), 'utf8');

function sourceOf(name) {
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

// 先頭の関数を返す。残りはそれが呼ぶ関数。
function extract(...names) {
  return new Function(`${names.map(sourceOf).join('\n')}\nreturn ${names[0]};`)();
}

const audioLag = extract('audioLag', 'fftInPlace');
const syncOffsets = extract('syncOffsets');
const syncDelays = extract('syncDelays');

const RATE = 4000;

// 再現できる乱数(テストのたびに結果が変わらないように)。
function noise(len, seed) {
  let s = seed;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s / 2 ** 31 - 1;
  }
  return out;
}

// 共通の音 base を枠ごとに shift 秒ずらし、その枠だけの音(別の乱数)を混ぜたものを作る。
function frameAudio(base, shiftSec, ownSeed, sec) {
  const own = noise(sec * RATE, ownSeed);
  const out = new Float32Array(sec * RATE);
  const lead = 12 * RATE; // base は前後に余裕を持たせてある
  for (let i = 0; i < out.length; i++) out[i] = base[i + lead - Math.round(shiftSec * RATE)] + own[i];
  return out;
}

test('audioLag: 片方にだけ別の音が乗っていても、ずれを測れる', () => {
  const base = noise(40 * RATE, 1);
  const a = frameAudio(base, 0, 11, 15);
  const b = frameAudio(base, 2.42, 12, 15); // b は a より 2.42 秒遅れ
  const m = audioLag(a, b, RATE, 10);
  assert.ok(Math.abs(m.lag - 2.42) < 0.001, `lag=${m.lag}`);
  assert.ok(m.ratio > 3, `ratio=${m.ratio}`);
});

test('audioLag: b のほうが進んでいれば負の値', () => {
  const base = noise(40 * RATE, 2);
  const m = audioLag(frameAudio(base, 1.5, 21, 15), frameAudio(base, 0, 22, 15), RATE, 10);
  assert.ok(Math.abs(m.lag + 1.5) < 0.001, `lag=${m.lag}`);
});

test('audioLag: 無関係な音どうしは ratio が低い', () => {
  const m = audioLag(noise(15 * RATE, 31), noise(15 * RATE, 32), RATE, 10);
  assert.ok(m.ratio < 3, `ratio=${m.ratio}`);
});

test('syncOffsets: つながっている枠の遅れを、1 枠目を基準に出す', () => {
  const off = syncOffsets(3, [{ i: 0, j: 1, lag: -2.4 }, { i: 1, j: 2, lag: 0.9 }]);
  assert.equal(off[0], 0);
  assert.ok(Math.abs(off[1] + 2.4) < 1e-9);
  assert.ok(Math.abs(off[2] + 1.5) < 1e-9);
});

test('syncOffsets: 同じ音が無い枠は null。いちばん大きい組を選ぶ', () => {
  // 0 は孤立、1-2-3 がつながっている
  const off = syncOffsets(4, [{ i: 1, j: 2, lag: 1 }, { i: 2, j: 3, lag: 1 }]);
  assert.deepEqual(off, [null, 0, 1, 2]);
});

test('syncOffsets: どの枠もつながらなければ null', () => {
  assert.equal(syncOffsets(3, []), null);
});

test('syncDelays: いちばん遅れている枠を 0 にして、ほかを遅らせる', () => {
  // 枠 0 がいちばん遅い。枠 1 は 2.4 秒、枠 2 は 1.5 秒進んでいる
  const next = syncDelays([0, 0, 0], [0, -2.4, -1.5], 20);
  assert.deepEqual(next.map((v) => Math.round(v * 100) / 100), [0, 2.4, 1.5]);
});

test('syncDelays: 既に付いている遅延を踏まえ、全体を前へ詰める', () => {
  // 遅延 [3, 1] の状態で測ったら、枠 1 がまだ 0.5 秒進んでいた → 枠 1 を 0.5 秒足して [3, 1.5]。
  // 両方に付いている 1.5 秒は無駄なので引く。
  const next = syncDelays([3, 1], [0, -0.5], 20);
  assert.deepEqual(next.map((v) => Math.round(v * 100) / 100), [1.5, 0]);
});

test('syncDelays: 対象外の枠は null のまま、上限を超えない', () => {
  assert.deepEqual(syncDelays([0, 5, 0], [0, null, -30], 20), [0, null, 20]);
});

test('audioEnvelope: 区間ごとの最大の振れに縮める', () => {
  const audioEnvelope = extract('audioEnvelope');
  // 4000Hz を 50 点/秒へ = 80 サンプルごと。2 区間ぶん。
  const pcm = new Float32Array(160);
  pcm[10] = -0.5;
  pcm[100] = 0.25;
  assert.deepEqual([...audioEnvelope(pcm, 4000, 50)], [0.5, 0.25]);
});
