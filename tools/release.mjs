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
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
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
// リンク先は latest 固定のまま触らない。書き換えるのは「保存されるファイル名」だけ。
const nameRe = /parallel-stream-\d+\.\d+\.\d+\.zip/g;
const zipName2 = `parallel-stream-${next}.zip`;
writeFileSync(
  htmlPath,
  readFileSync(htmlPath, 'utf8').replace(/\?v=\d+\.\d+\.\d+/g, `?v=${next}`).replace(nameRe, zipName2)
);
const bridgePath = p('ext-bridge.js');
writeFileSync(bridgePath, readFileSync(bridgePath, 'utf8').replace(nameRe, zipName2));
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
// dist ごと消さないこと。過去の版の zip を消すと、古いページを開いたままの利用者の
// リンクが 404 になる(実際に起きた)。作業フォルダだけ作り直す。
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of PACK) {
  if (!existsSync(p(f))) {
    console.error(`同梱するファイルが見つかりません: ${f}`);
    process.exit(1);
  }
  cpSync(p(f), join(stage, f));
}

// zip は PowerShell の Compress-Archive で作る(依存を増やさないため)。
// 中身はフォルダを作らず平置きにする。フォルダごと固めると Compress-Archive が
// パス区切りに Windows 式の \ を書き、ZIP 仕様(/ が正)から外れる。Android の展開ツールは
// それを区切りと解釈せず「parallel-stream-0.9.11\manifest.json」という名前の1ファイルとして
// 展開してしまい、拡張機能の読み込みが manifest 無しで失敗した(実機で発生)。
// 平置きなら区切り自体が無いので起きない。版は zip のファイル名に入っているので、
// 展開すればその名前のフォルダができる。
const zipName = `${stageName}.zip`;
const zipPath = p('dist', zipName);
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`],
  { stdio: 'inherit' }
);
cpSync(zipPath, p('dist', 'parallel-stream-latest.zip'));

console.log(`\n配布物:`);
console.log(`  dist/${zipName}                (ページからはこちらを配る。ファイル名で版が分かる)`);
console.log(`  dist/parallel-stream-latest.zip (版を知らない相手向けの固定 URL)`);
console.log(`  中身は平置き。展開すると ${stageName}/ ができ、そのフォルダを拡張機能として読み込みます。`);

// 展開して壊れないことを確かめる。区切り文字の事故は実機まで気づけないので、ここで止める。
const entries = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `$z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath}'); ` +
      `$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`,
  ],
  { encoding: 'utf8' }
)
  .split(/\r?\n/)
  .filter(Boolean);
const bad = entries.filter((e) => e.includes('\\') || e.includes('/'));
if (bad.length) {
  console.error(`\nzip の中にパス区切りが入っています(平置きのはず):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
if (!entries.includes('manifest.json')) {
  console.error('\nzip の直下に manifest.json がありません。');
  process.exit(1);
}
console.log(`  検査: ${entries.length} ファイル、すべて直下。manifest.json あり。`);

// 過去の版は残すが、際限なく増やさない。古いページからのリンク切れを防ぐぶんだけ持つ。
const KEEP = 5;
const olds = readdirSync(p('dist'))
  .filter((f) => /^parallel-stream-\d+\.\d+\.\d+\.zip$/.test(f))
  .sort((a, b) => {
    const num = (s) => s.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
    const [a1, a2, a3] = num(a);
    const [b1, b2, b3] = num(b);
    return b1 - a1 || b2 - a2 || b3 - a3;
  });
for (const f of olds.slice(KEEP)) {
  rmSync(p('dist', f), { force: true });
  console.log(`  古い配布物を削除: ${f}`);
}
console.log(`  残している版: ${olds.slice(0, KEEP).join(', ')}`);

// zip を作る前の作業フォルダは、作った後は用が無い。放っておくと版のぶんだけ溜まり続けるので
// (git は追跡していないが、手元のディスクと検索結果を汚す)、今回のもの以外は消す。
const stages = readdirSync(p('dist'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^parallel-stream-\d+\.\d+\.\d+$/.test(e.name) && e.name !== stageName);
for (const e of stages) rmSync(p('dist', e.name), { recursive: true, force: true });
if (stages.length) console.log(`  古い作業フォルダを削除: ${stages.length} 件`);
console.log(`\n次: git add -A && git commit && git push`);
