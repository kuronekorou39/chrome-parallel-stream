# Parallel Stream

Twitch / YouTube / OPENREC / Kick の配信を、1画面にタイル表示して同時に見るための Chrome 拡張機能です。
枠ごとの音量調整、コメント弾幕、レイアウト保存、スマホ向けの縦積み表示に対応しています。

素の JavaScript のみで、ビルド不要・npm 依存なしです。Manifest V3。

---

## できること

- **マルチビュー** — 配信ページを枠(iframe)として並べ、自由配置またはタイル整列で同時視聴
- **枠ごとの音量** — サイト側のプレイヤー UI に触らず、各枠の音量とミュートをまとめて制御
- **コメント弾幕** — 枠のチャットを取得して映像の上に流す(Twitch ライブ/VOD・YouTube ライブ・OPENREC)
- **軽量プレイヤー切替(⚡)** — フルサイトではなく公式埋め込みプレイヤーだけを読み込み、負荷を下げる
- **レイアウト保存** — 枠の URL・位置・サイズ・音量を名前付きで保存して呼び出す
- **縦積みモード** — スマホ向けに全幅タイルを縦に並べ、長押しドラッグで並び替え

Kick のみ、サイトを埋め込まず [hls.js](https://github.com/video-dev/hls.js) で HLS を直接再生します。

### やらないこと

広告ブロックは**このリポジトリには含まれません**。別プロジェクト
[chrome-ad-skipper](https://github.com/kuronekorou39/chrome-ad-skipper) の担当です。両方を入れると枠の中でも
広告スキップが効きます(理由は後述の「UI ページを通常のオリジンに置いている理由」を参照)。

---

## インストール

1. このリポジトリをクローンする
2. Chrome で `chrome://extensions` を開き、「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」で、`manifest.json` があるディレクトリを選ぶ
4. ツールバーのアイコン → 「マルチビューを開く」

---

## この拡張がブラウザに与える影響

配信サイトを iframe で並べるという性質上、通常の拡張機能より踏み込んだことをしています。
**インストールする前に理解してください。**

### 1. 対象サイトの CSP と X-Frame-Options を除去します

`rules.json` の declarativeNetRequest ルールで、Twitch / YouTube / Kick / OPENREC への **サブフレーム
リクエスト**から `content-security-policy` と `x-frame-options` を削除します。

各サイトは iframe への埋め込みを明示的に拒否しているため、これを外さないとマルチビューは成立しません。
CSP も外しているのは、`frame-ancestors` ディレクティブが同様に埋め込みを拒否するためで、
declarativeNetRequest はヘッダ単位でしか操作できず「そのディレクティブだけ外す」ことができないからです。

**副作用:** このルールは適用範囲を絞っていないため、この拡張を入れている間は、あなたが訪れる
**任意のサイト**がこれらのドメインを iframe で埋め込んだ場合にも適用されます。埋め込まれたページは
CSP による保護を失った状態で読み込まれます。

### 2. 対象サイトの Cookie を `SameSite=None` に書き換えます

枠の中でログイン状態を保つ(チャットに書き込む等)ために、`twitch.tv` / `openrec.tv` / `kick.com` の
Cookie を `SameSite=None; Secure` へ再設定します。

**副作用:** この変更は拡張のページ内だけでなく、**ブラウザ全体に永続します**。以後これらのサイトへの
クロスサイトリクエストにも Cookie が送られるため、CSRF に対する防御が弱まります。
**拡張を削除しても元には戻りません**(サイト側が Cookie を再設定するまで残ります)。

### 3. 枠の中でページの可視状態を偽装します

枠が画面外・バックグラウンドでも再生が止まらないよう、枠の中に限り `document.hidden` /
`visibilityState` / `hasFocus` を「常に可視」で固定し、`visibilitychange` を握り潰します。
通常のタブには影響しません。サイト側の省電力・帯域節約の処理も一緒に無効になります。

### 4. 権限について

`host_permissions` に `<all_urls>` を要求しています。上記のヘッダ操作と、任意の配信ページを枠として
読み込む必要があるためです。`cookies` は 2. のため、`system.cpu` / `system.memory` は
パフォーマンスパネルの表示に使っています。

---

## UI ページを通常のオリジンに置いている理由

マルチビューの UI は、拡張ページ(`chrome-extension://`)ではなく通常の https ページとして配信しています
(GitHub Pages)。拡張ページ版も同梱していて同じように動きますが、既定では通常ページ版を開きます。

理由は Chrome の仕様です。**拡張ページの中にある iframe には、他の拡張の content script が一切注入
されません。** 宣言的な `content_scripts` も `chrome.scripting.executeScript` も通らず、後者は
`Cannot access contents of the page` で失敗します。そのため拡張ページ版では、広告スキッパーのような
他の拡張が枠の中でまったく効きません。UI を通常のオリジンに置くと、枠は「普通のウェブページの中の
iframe」になり、他の拡張が問題なく動くようになります。

ページから拡張の機能(設定の保存、Cookie 緩和、Kick の再生 URL 取得など)を使うために、
`ext-bridge.js`(ページ側)と `page-bridge.js`(content script)が `postMessage` で橋渡しをしています。
`multiview.js` は `chrome.*` を直接呼ばず、`MV.*` 経由で統一しています。

---

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | Manifest V3 定義 |
| `multiview.html` / `.js` / `.css` | マルチビュー UI 本体 |
| `ext-bridge.js` | ページ側から拡張機能を使うための `MV.*`(拡張ページ / 通常ページ両対応) |
| `page-bridge.js` | 通常ページ用の中継 content script |
| `background.js` | service worker(Cookie 緩和・Kick API・ブリッジ中継) |
| `stream-control.js` | 枠の中で動く content script(音量・枠内シアター・弾幕のチャット取得) |
| `keepalive-visibility.js` | 枠の中で Page Visibility を偽装(バックグラウンドでも止めない) |
| `twitch-keepalive.js` | `player.twitch.tv` 用の IntersectionObserver 差し替え |
| `rules.json` | CSP / X-Frame-Options 除去の declarativeNetRequest ルール |
| `popup.html` / `.js` / `.css` | ツールバーのポップアップ(入口) |
| `hls.min.js` / `hls.worker.js` | [hls.js](https://github.com/video-dev/hls.js)(Kick の HLS 直接再生用) |
| `api-surface.js` / `windows-probe.js` / `webview-probe.js` / `fullscreen-probe.js` | 初期のケイパビリティ調査用プローブ(ポップアップの Probe タブから手動実行) |

---

## ライセンス

[MIT](LICENSE)

同梱しているサードパーティコードとその表示は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) を参照してください。
