// 枠ごとの遅延まわりの純粋関数を検証する。
//   - multiview.js の clampDelay(sec, max)
//   - twitch-keepalive.js の mvDelayPlan(err, ahead, back)
// どちらもブラウザ専用スクリプトなので、関数定義だけをソースから抜き出して評価する
// (やり方は cmpVersion.test.mjs と同じ)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractFunction(file, name) {
  const src = readFileSync(join(ROOT, file), 'utf8');
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

const clampDelay = extractFunction('js/audio.js', 'clampDelay');
const mvDelayPlan = extractFunction('twitch-keepalive.js', 'mvDelayPlan');

test('clampDelay: 0.01 秒刻みに丸める(足し算の誤差を残さない)', () => {
  assert.equal(clampDelay(0.1 + 0.2, 20), 0.3);
  assert.equal(clampDelay(1.004, 20), 1);
  assert.equal(clampDelay(2.416, 20), 2.42);
});

test('clampDelay: 0〜max に収め、数でないものは 0', () => {
  assert.equal(clampDelay(-0.1, 20), 0);
  assert.equal(clampDelay(25, 20), 20);
  assert.equal(clampDelay('abc', 20), 0);
});

test('mvDelayPlan: 合っていれば等速', () => {
  assert.deepEqual(mvDelayPlan(0.02, 5, 10), { rate: 1 });
  assert.deepEqual(mvDelayPlan(-0.02, 5, 10), { rate: 1 });
});

test('mvDelayPlan: 小さなずれは速度で詰める(シークしない)', () => {
  assert.deepEqual(mvDelayPlan(0.1, 5, 10), { rate: 0.8 });
  assert.deepEqual(mvDelayPlan(-0.1, 5, 10), { rate: 1.2 });
});

test('mvDelayPlan: 大きく遅らせるときは、戻れるバッファがあればシーク、無ければ低速で溜める', () => {
  assert.deepEqual(mvDelayPlan(5, 2, 10), { seek: -5 });
  assert.deepEqual(mvDelayPlan(5, 2, 5.2), { rate: 0.25 });
});

test('mvDelayPlan: 進めるときは先読みを 1 秒残す', () => {
  assert.deepEqual(mvDelayPlan(-5, 8, 10), { seek: 5 });
  assert.deepEqual(mvDelayPlan(-5, 4, 10), { seek: 3 });
  assert.deepEqual(mvDelayPlan(-5, 1.3, 10), { rate: 1.2 }); // 余地が少ないのでシークしない
  assert.deepEqual(mvDelayPlan(-5, 0.8, 10), { rate: 1 }); // 余地が無い
});
