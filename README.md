# chrome-parallel-stream

Android 上で動く自作 Chromium ベースブラウザに「複数ライブ配信を1画面にタイル表示するマルチビュー機能」を載せられるか、その実現可能性を **実機で確定** させるための Phase 1 拡張機能。

このリポジトリは **動くプロダクトではなく、ケイパビリティ・プローブ** です。Phase 2 の設計をどちらに振るか（拡張機能だけで作れるのか、それともブラウザネイティブに独自API追加が要るのか）を判断するための材料を集めます。

---

## このフェーズで知りたいこと

1. その自作ブラウザの拡張ランタイムでは、標準の Chrome 拡張 API 以外に **独自の `chrome.*` namespace** が露出しているか？
   - 例: `chrome.multiview`、`chrome.tile`、`chrome.webview`、`chrome.layout` など
2. `chrome.windows.create` で「並んで描画される別ウィンドウ」を作れるか？それとも単に別タブに吸収されるか？
3. `requestFullscreen()` がユーザージェスチャ起源以外で通るか？通らないなら、配信サイトの **シアターモード** ボタンを `click()` する迂回が現実的か？

これらの答えで Phase 2 の設計が大きく変わります。

---

## インストール手順

> **TODO（ユーザーが埋める欄）**
>
> 自作ブラウザの「拡張機能の読み込み方」をここに書く。
> 例:
>
> - [ ] 自作ブラウザのアドレスバーに `chrome://extensions` を開く（あるいは設定 → 拡張機能 → 開発者モード）
> - [ ] 開発者モード ON
> - [ ] 「パッケージ化されていない拡張機能を読み込む」で、このリポジトリのルート（`manifest.json` がある場所）を選ぶ
> - [ ] ツールバーに「Parallel Stream Probe」アイコンが現れる
> - [ ] アイコンをタップ → ポップアップが開く → "Re-run probes" を押す
> - [ ] 結果が表示されたら "Copy report as Markdown" でクリップボードへ
>
> ※ Android 版 Chromium で拡張機能ローダがどう露出しているかは実装依存。手順が確定したらここを書き換える。

---

## プローブの構成

### A. `probes/api-surface.js` — 全namespace列挙

- `Object.keys(chrome)` で chrome.* を全列挙
- 各 namespace について、深さ2まで関数・プロパティを再帰列挙
- 標準 Chrome 拡張 API リスト（[公式リファレンス](https://developer.chrome.com/docs/extensions/reference/api)を参考にハードコード）と突き合わせ、**標準に無いものを「★ CUSTOM API DETECTED」としてマーク**
- 各APIの `typeof`（function/object）も記録

### B. `probes/windows-probe.js` — windows API 挙動検証

- `chrome.windows.create({url, type, width, height, left, top})` を `type` ごとに3回呼ぶ
  - `'normal'` / `'popup'` / `'panel'`
- 返ってきた Window オブジェクトをシリアライズして記録
- 500ms 待ってから `chrome.windows.getAll({populate: true})` で全ウィンドウ列挙
  - → Android 上で「本当に並んだウィンドウになっているのか」「同一タブスタックに吸収されたのか」を確認するため
- プローブで作ったウィンドウは `chrome.windows.remove` でクリーンアップ

### C. `probes/fullscreen-probe.js` — requestFullscreen 検証

- アクティブタブに content script として注入される（`chrome.scripting.executeScript`）
- `document.documentElement.requestFullscreen()` の挙動を記録
  - 成功 / Promise reject / 同期 throw のどれか
  - reject なら `err.name` と `err.message`
- 配信サイト（Twitch / YouTube / Kick / OPENREC）では「シアターモード」ボタンを `querySelector` で探し、見つかれば `click()` してみる
  - ⚠ DOMセレクタは推測値。**`// TODO(human):` コメントを付けているので、実機で開発者ツールから本当のセレクタを取って差し替える**こと
  - 参考: 配信サイトのDOMは頻繁に変わるので、Phase 2 着手時に再調査必須

### D. `probes/webview-probe.js` — 独自API探索

- 「あったら嬉しい名前空間」を直接叩く:
  - `chrome.multiview`, `chrome.tile`, `chrome.webview`, `chrome.layout`, `chrome.split`, `chrome.splitView`, `chrome.parallel`, `chrome.mosaic`, `chrome.pip`, `chrome.pictureInPicture`
  - WebExtensions 流の `browser.*` 側も同じ調子で確認
- さらに、`Object.keys(chrome)` の全列挙結果と標準APIリストを突き合わせて、**標準外として検出された全 namespace** を独自候補としてダンプ
- 見つかればメソッド/プロパティを反射的に列挙

---

## 結果の見方

ポップアップを開くと以下のセクションが並びます。

| セクション | 何を見るか |
| --- | --- |
| **Custom APIs (★)** | ここに何か出れば「自作ブラウザに独自 namespace が露出している」シグナル。Phase 2 はそれを使う方針で進められる。 |
| **Windows Probe Result** | `type: 'normal'` で `windowsAfter` を見て、作ったウィンドウが本当に別ウィンドウとして列挙されているかを確認。Android では多くの場合 `popup` / `panel` がサポートされず、`normal` も別タブとして吸収される。 |
| **Fullscreen Probe Result** | `requestFullscreen` の結果。`rejected` で `NotAllowedError` なら「ユーザージェスチャ無しでは無理」が確定。`theaterModeAttempts` の `clicked: true` があれば、シアターモード経由の擬似全画面化は実装可能。 |
| **Webview / Custom Namespace Probe** | `detectedCustomFromChromeKeys` に列挙された名前は、すべて「標準外のなにか」。Phase 2 の素材になる可能性大。 |
| **Errors** | プローブ単位の失敗ログ。空が望ましい。 |
| **Meta** | 実行時刻、UA、プラットフォームなど。 |

### ★ マークの意味

- **★ CUSTOM** = 標準 Chrome 拡張 API のリストに含まれない namespace。
- 標準リストは `probes/api-surface.js` の `STANDARD_CHROME_EXTENSION_APIS` にハードコードしている。
  - もし標準仕様側で増えた API（新しすぎてリストに入っていない）が誤検出された場合は、このリストに追加する。

### 想定される結果パターン

| パターン | 解釈 |
| --- | --- |
| Custom APIs が空 + windows.create が別ウィンドウを返さない | 通常の Android Chromium。拡張機能だけではマルチビューは作れない → **ブラウザネイティブに独自API追加が必要**。 |
| Custom APIs に `chrome.multiview` などが出る | 自作ブラウザに既に独自API露出あり。**Phase 2 はそのAPI上に拡張機能で実装可能**。 |
| Custom APIs は空 / でも `windows.create({type:'popup'})` が `windowsAfter` で並列に並ぶ | 拡張機能の標準API範囲でマルチウィンドウが効く。タイル配置はネイティブ側のウィンドウマネージャ次第。 |
| Fullscreen が reject / シアターモードボタンが click 成功 | 各ストリーミングサイトのDOM操作で擬似全画面化 → Phase 2 で各サイトのDOM適応層を作る方針が成立。 |

---

## Next steps（Phase 2 へのインプット）

このプローブの結果次第で、Phase 2 はこう振り分けます:

- **Custom API が見つかった場合** → そのAPIをラップした薄い拡張機能としてマルチビューUIを実装。優先度高。
- **Custom API は無いが windows.create が並列描画する場合** → 標準API（`chrome.windows` + `chrome.tabs`）だけで Phase 2 を進める。ただしレイアウト制御の限界に注意。
- **どちらも成立しない場合** → 結論: 拡張機能だけでは無理。**ブラウザネイティブ側に独自API（`chrome.multiview` 相当）を生やす Phase 1.5 を挟む**。プローブが返した「何が足りないか」が、その独自APIの設計の出発点になる。

---

## ファイル構成

```
chrome-parallel-stream/
├── README.md             ← このファイル
├── manifest.json         ← Manifest V3
├── background.js         ← service worker / プローブ統合実行
├── popup.html            ← 結果表示UI
├── popup.js              ← UI制御 + JSON/Markdownエクスポート
├── popup.css             ← ダーク基調・等幅
├── content.js            ← 動的注入用プレースホルダー（空）
└── probes/
    ├── api-surface.js    ← 全namespace列挙、★マーク判定、標準APIセット定義
    ├── windows-probe.js  ← windows.create 挙動検証
    ├── fullscreen-probe.js ← content script として注入、requestFullscreen + シアターモード
    └── webview-probe.js  ← 独自name space 探索（api-surface.js の標準セットを参照）
```

---

## 注意・前提

- 素のJavaScriptのみ。ビルド不要、npm依存なし。
- Manifest V3。`host_permissions: ["<all_urls>"]` はプローブ目的で広めに取っているので、Phase 2 では絞る前提。
- 各プローブは独立してエラーハンドリングされる（1つコケても他は走る）。
- `Copy report as Markdown` 出力は Claude に貼り戻す用途を想定。`Copy report as JSON` は生データ用。
