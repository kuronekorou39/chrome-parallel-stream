// リリース用の版上げと配布物づくり。
//
//   node tools/release.mjs           … パッチ版を1つ上げる (0.9.5 → 0.9.6)
//   node tools/release.mjs 1.0.0     … 版を指定する
//   node tools/release.mjs --check   … 版を上げずに整合だけ見る
//
// 版番号は3箇所に散っていて、手で合わせるとずれる(実際にずれた)。ここで一括して書き換える。
//   manifest.json            拡張機能の版
//   multiview.html の ?v=    Pages のキャッシュ避け
//   multiview.js の EXPECTED_EXT_VERSION  ページが要求する拡張の版
//
// 配布物は dist/ に置く。zip の中身は「展開したフォルダがそのまま拡張機能」になる形にする
// (BEX の『未パッケージ拡張機能をフォルダから読み込む』にそのまま渡せるようにするため)。
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...a) => join(ROOT, ...a);

// 拡張機能として必要なファイルだけを入れる。ページ側の資産(multiview.*, ext-bridge.js, hls.*)は
// GitHub Pages が配るので同梱しない。README/ログ/スクリーンショットも入れない。
const PACK = [
  'manifest.json',
  'rules.json',
  'background.js',
  'stream-control.js',
  'keepalive-visibility.js',
  'twitch-keepalive.js',
  'page-bridge.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicit = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));

const manifestPath = p('manifest.json');
const htmlPath = p('multiview.html');
const jsPath = p('multiview.js');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cur = manifest.version;

function readVersions() {
  const html = readFileSync(htmlPath, 'utf8');
  const js = readFileSync(jsPath, 'utf8');
  const qv = [...new Set([...html.matchAll(/\?v=(\d+\.\d+\.\d+)/g)].map((m) => m[1]))];
  const ev = (js.match(/EXPECTED_EXT_VERSION = '([\d.]+)'/) || [])[1];
  return { manifest: JSON.parse(readFileSync(manifestPath, 'utf8')).version, query: qv, expected: ev };
}

function report(v) {
  console.log(`  manifest.json          : ${v.manifest}`);
  console.log(`  multiview.html の ?v=  : ${v.query.join(', ') || '(無し)'}`);
  console.log(`  EXPECTED_EXT_VERSION   : ${v.expected}`);
  const ok = v.query.length === 1 && v.query[0] === v.manifest && v.expected === v.manifest;
  console.log(ok ? '  → 一致' : '  → ずれている');
  return ok;
}

if (checkOnly) {
  console.log('現在の版:');
  process.exit(report(readVersions()) ? 0 : 1);
}

const next = explicit || cur.replace(/(\d+)$/, (n) => String(Number(n) + 1));
console.log(`版を上げます: ${cur} → ${next}`);

manifest.version = next;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
// ?v= と、ZIP への直リンクを版入りに揃える。
// 直リンクを固定名(latest)のままにすると、落とすたびにブラウザが (1)(2) を付けてしまい、
// どれが最新か分からなくなる。JS 側で後から差し替える作りにしていたが、押す方が速いと
// 間に合わないので、配る HTML の時点で版入りにしておく。
const zipRe = /dist\/parallel-stream-[\w.]+\.zip/g;
const zipHref = `dist/parallel-stream-${next}.zip`;
writeFileSync(
  htmlPath,
  readFileSync(htmlPath, 'utf8').replace(/\?v=\d+\.\d+\.\d+/g, `?v=${next}`).replace(zipRe, zipHref)
);
const bridgePath = p('ext-bridge.js');
writeFileSync(bridgePath, readFileSync(bridgePath, 'utf8').replace(zipRe, zipHref));
writeFileSync(
  jsPath,
  readFileSync(jsPath, 'utf8').replace(/EXPECTED_EXT_VERSION = '[\d.]+'/, `EXPECTED_EXT_VERSION = '${next}'`)
);

console.log('書き換え後:');
if (!report(readVersions())) {
  console.error('版がそろっていません。中止します。');
  process.exit(1);
}

// ---- 配布物 ----
// フォルダ名に版を入れる。展開したフォルダを読み込む運用なので、名前を見れば
// どの版を入れたのか分かるようにするため(同じ名前だと入れ替えたかも分からない)。
const stageName = `parallel-stream-${next}`;
const stage = p('dist', stageName);
rmSync(p('dist'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of PACK) {
  if (!existsSync(p(f))) {
    console.error(`同梱するファイルが見つかりません: ${f}`);
    process.exit(1);
  }
  cpSync(p(f), join(stage, f));
}

// zip は PowerShell の Compress-Archive で作る(依存を増やさないため)。
// フォルダごと固めるので、展開すると parallel-stream-<版>/ が出てくる。
const zipName = `${stageName}.zip`;
const zipPath = p('dist', zipName);
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -Force`],
  { stdio: 'inherit' }
);
cpSync(zipPath, p('dist', 'parallel-stream-latest.zip'));

console.log(`\n配布物:`);
console.log(`  dist/${zipName}                (ページからはこちらを配る。ファイル名で版が分かる)`);
console.log(`  dist/parallel-stream-latest.zip (版を知らない相手向けの固定 URL)`);
console.log(`  展開すると ${stageName}/ が出てきます。そのフォルダを拡張機能として読み込みます。`);
console.log(`\n次: git add -A && git commit && git push`);
