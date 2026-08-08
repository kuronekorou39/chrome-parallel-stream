// 公開と、作業中の確認用ページの更新。
//
//   node tools/publish.mjs        … main を release へ進める(= 利用者に公開する)
//   node tools/publish.mjs dev    … いまの main の UI を、公開サイトの /dev/ へ置く(自分の確認用)
//
// GitHub Pages は release ブランチを配っている。main へ push しただけでは利用者に届かない。
// ただし確認は本番と同じオリジンでやる必要がある(埋め込み制限を外す rules.json も、拡張の
// content script も、kuronekorou39.github.io に対してだけ効くため)。そこで release の中に
// dev/ を置き、そこへ作業中の UI を写す。利用者が見るのはルート側なので影響しない。
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...a) => join(ROOT, ...a);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

// /dev/ に置く UI 一式。ここに無いものはルート(= 公開版)を見に行くことになるので、
// 参照している資産はすべて含めること。
const UI_FILES = ['multiview.html', 'multiview.js', 'multiview.css', 'ext-bridge.js', 'hls.min.js', 'hls.worker.js'];
// 配布 ZIP も一緒に置く。ページからのリンクは相対なので、/dev/ からは /dev/dist/ を見に行く。
// ここに置かないとリンクが 404 になるうえ、置くべきは公開版ではなく「このページに合う版」
// (確認用ページは main の UI なので、拡張も main のものでないと版が食い違う)。
const ZIP = 'dist/parallel-stream-latest.zip';

const mode = process.argv[2] === 'dev' ? 'dev' : 'release';
const PAGES = 'https://kuronekorou39.github.io/chrome-parallel-stream';

if (git('status', '--porcelain')) {
  console.error('コミットしていない変更があります。先に commit してください。');
  process.exit(1);
}

if (mode === 'release') {
  console.log('main を release へ進めます(利用者に公開されます)。');
  execFileSync('git', ['push', 'origin', 'main:release'], { cwd: ROOT, stdio: 'inherit' });
  console.log(`\n公開しました: ${PAGES}/multiview.html`);
  console.log('反映まで1分ほどかかります。');
  process.exit(0);
}

// dev: 公開中の release を別フォルダへ取り出し、UI だけ写して push する。
// ローカルの release ブランチは持たない(main から直接進める運用なので、持つと必ず古くなる)。
// origin/release を切り離して取り出し、その上に積んで押し戻す。
const work = p('.publish-dev');
rmSync(work, { recursive: true, force: true });
try { git('worktree', 'prune'); } catch (e) { /* noop */ }
execFileSync('git', ['fetch', '--quiet', 'origin', 'release'], { cwd: ROOT, stdio: 'inherit' });
execFileSync('git', ['worktree', 'add', '--quiet', '--detach', work, 'origin/release'], { cwd: ROOT, stdio: 'inherit' });
try {
  const devDir = join(work, 'dev');
  mkdirSync(devDir, { recursive: true });
  for (const f of UI_FILES) {
    if (!existsSync(p(f))) { console.error(`見つかりません: ${f}`); process.exit(1); }
    cpSync(p(f), join(devDir, f));
  }
  if (existsSync(p(ZIP))) {
    mkdirSync(join(devDir, 'dist'), { recursive: true });
    cpSync(p(ZIP), join(devDir, ZIP));
  }
  // 変更の有無は add したあとの索引で見る。作業ツリーの比較だと、改行コードの正規化のせいで
  // 中身が同じでも「変更あり」に見えてしまう(実際に空コミットで失敗した)。
  execFileSync('git', ['add', 'dev'], { cwd: work, stdio: 'inherit' });
  let staged = true;
  try { execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: work }); staged = false; } catch (e) { staged = true; }
  if (!staged) {
    console.log('確認用ページは既に最新です。');
  } else {
    execFileSync('git', ['commit', '-m', 'chore: 確認用ページ(dev)を更新'], { cwd: work, stdio: 'inherit' });
  }
  execFileSync('git', ['push', 'origin', 'HEAD:release'], { cwd: work, stdio: 'inherit' });
  console.log(`\n確認用: ${PAGES}/dev/multiview.html`);
  console.log('反映まで1分ほどかかります。利用者が見るページ(ルート)は変わりません。');
} finally {
  execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: ROOT, stdio: 'inherit' });
}
