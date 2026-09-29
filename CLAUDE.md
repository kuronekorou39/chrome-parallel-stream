# chrome-parallel-stream (Parallel Stream)

Twitch / YouTube / mellow-fan(旧 OPENREC) / Kick の配信を1画面に並べて同時に見るための
Chrome 拡張機能(Manifest V3)。素の JavaScript のみで、ビルド不要・npm 依存なし。

利用者向けの説明は [README.md](README.md)、ブラウザへの影響は
[docs/browser-impact.md](docs/browser-impact.md)、設計の背景は
[docs/design.md](docs/design.md) を参照(このファイルと矛盾する場合は docs/design.md を優先)。

## 構成の要点

マルチビュー UI(`multiview.*`)は拡張ページではなく通常の https ページとして
GitHub Pages(`release` ブランチ)から配信している。拡張ページ内の iframe には
他拡張の content script が注入できない(Chrome の仕様)ため、枠の中で
広告スキッパーなどの他拡張を効かせる目的でこの構成にしている。詳細は design.md。

- `main` ブランチ = 作業用。push しても利用者には届かない
- `release` ブランチ = 公開用。GitHub Pages が配るのはここ

## ディレクトリ構成

| パス | 役割 |
| --- | --- |
| `manifest.json` | 拡張機能の定義(MV3)。バージョンは3箇所に散っているので手で編集しない → 下記コマンド |
| `background.js` | service worker |
| `popup.html/css/js` | ツールバーの拡張アイコンを押したときのポップアップ |
| `multiview.html/css/js` | マルチビュー本体の UI。GitHub Pages から配信、拡張ページ版も同梱 |
| `stream-control.js` | 各配信サイトへの content script(枠内の制御) |
| `twitch-keepalive.js` / `keepalive-visibility.js` | バックグラウンドでも再生を止めないための MAIN world script |
| `page-bridge.js` / `ext-bridge.js` | ページ(`multiview.js`)⇔拡張機能の `postMessage` 橋渡し。`multiview.js` は `chrome.*` を直接呼ばず `MV.*` 経由 |
| `rules.json` | `declarativeNetRequest` ルール(埋め込みのための `X-Frame-Options` 除去など) |
| `hls.min.js` / `hls.worker.js` | third_party/hls.js の同梱ビルド。Kick だけ埋め込みでなくこれで HLS を直接再生(拡張ページ文脈だと内部リクエストが 404 になるため) |
| `third_party/hls.js/` | 同梱コードのライセンス原本 |
| `docs/` | `browser-impact.md`(権限・Cookie・可視状態偽装の詳細)、`design.md`(設計メモ)、`images/`(README 用スクリーンショット) |
| `tools/` | `release.mjs`(版上げ・ZIP 作成)、`publish.mjs`(公開・確認用ページ反映) |
| `dist/` | 配布用 ZIP。バージョン付きのものは git 管理、展開フォルダ(`dist/parallel-stream-*/`)は生成物なので gitignore |
| `chromium-repro/` | Chromium 側のレンダラークラッシュの最小再現(README.md + extension/ + repro.html)。このリポジトリの機能ではなくバグ報告用の別資産 |
| `tests/` | 自動テスト(Node 標準の test runner)。`multiview.js` 等のブラウザ専用スクリプトから、window/document に依存しない純粋関数だけをソースごと抜き出して検証する |
| `_metadata/` | Chrome が実行時に自動生成する成果物(gitignore、触らない) |
| `.repohub/` | 作業ログ・backlog の置き場。ユーザーのグローバル gitignore で無視されるため、ここに置いたものは通常 git 管理下に入らない |

## 開発・確認・ビルド・公開のコマンド

自動テストは Node 標準の test runner(`node:test`)のみで、npm install は不要。UI の見た目や
実際の配信サイトでの動作確認は自動化されておらず、引き続き Chrome に読み込んで手で行う。

- `node --test` — `tests/` 以下の自動テストを実行する(ディレクトリを明示すると
  `node --test tests/` が `tests` という名のスクリプトを require しようとして落ちる環境がある
  ため、引数無しでデフォルトの探索に任せること)
- ローカルで動かす: `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない
  拡張機能を読み込む」でこのフォルダを選ぶ
- UI の作業中の見た目を確認する: 拡張機能に同梱されている
  `chrome-extension://<拡張ID>/multiview.html?dev=1` を開く(`?dev=1` が無いと GitHub Pages へ
  転送される)。他拡張(広告スキッパー等)は拡張ページ内では効かない点に注意
- `node tools/release.mjs` — パッチ版を1つ上げ、`manifest.json` / `multiview.html` の `?v=` /
  `multiview.js` の `EXPECTED_EXT_VERSION` を揃えて `dist/` に配布用 ZIP を作る
- `node tools/release.mjs 1.0.0` — 版を明示指定して同様に行う
- `node tools/release.mjs --check` — 版を上げずに3箇所の整合だけ確認する
- `node tools/publish.mjs dev` — 作業中の main の UI を GitHub Pages の `/dev/` へ反映する
  (本番と同じオリジンでの確認用。commit 済みであることが前提)
- `node tools/publish.mjs` — `main` を `release` へ進めて利用者に公開する(= 実行した瞬間に届く)

## 守るべきルール

- **UI ファイル(`multiview.*` / `ext-bridge.js`)を変えたら必ず `node tools/release.mjs` で
  版を上げる。** `?v=` が据え置きだと GitHub Pages のキャッシュが効いて古い JS/CSS のまま配られる
- **`main` への push だけでは公開されない。** 公開は `node tools/publish.mjs` を実行した時
  (または `git push origin main:release`)だけ利用者に届く。安易に release へ進めない
- UI を通常オリジン(GitHub Pages)に置く構成は意図的な設計(design.md 参照)。「拡張ページに
  戻す」方向の変更は提案しない
- 広告スキップ機能はこのリポジトリの担当外(別リポジトリ `chrome-ad-skipper` の責務)。
  持ち込まない
- `hls.min.js` / `hls.worker.js` はコード自体を改変しない(上流のビルド成果物 + ライセンス
  ヘッダのみ付与)。更新する場合は `third_party/hls.js/` と `THIRD-PARTY-NOTICES.md` を版と
  合わせて更新する
- `chromium-repro/` はこのリポジトリの実装とは無関係な、Chromium バグ報告用の最小再現。
  本体の変更のついでに触らない
- `.repohub/` はユーザーのグローバル gitignore で無視される。ここに置いた資産を版管理したい
  場合は別途置き場を検討する(backlog.md 参照)
