// UI のスクリプト(js/*.js)を、multiview.html の読み込み順につなげて返す。
// テストは関数や定数の定義をソースから抜き出して評価するので、どのファイルにあるかを意識しなくて済む。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function uiScripts() {
  const html = readFileSync(join(ROOT, 'multiview.html'), 'utf8');
  return [...html.matchAll(/<script src="(js\/[\w-]+\.js)/g)].map((m) => m[1]);
}

export function uiSource() {
  return uiScripts().map((f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')).join('\n');
}
