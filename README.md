# Parallel Stream

Twitch / YouTube / mellow-fan(旧 OPENREC) / Kick の配信を、1画面にタイル表示して同時に見るための Chrome 拡張機能です。
枠ごとの音量調整、コメント弾幕、レイアウト保存、スマホ向けの縦積み表示に対応しています。

素の JavaScript のみで、ビルド不要・npm 依存なしです。Manifest V3。

---

## できること

- **マルチビュー** — 配信ページを枠(iframe)として並べ、自由配置またはタイル整列で同時視聴
- **枠ごとの音量** — サイト側のプレイヤー UI に触らず、各枠の音量とミュートをまとめて制御
- **コメント弾幕** — 枠のチャットを取得して映像の上に流す(Twitch ライブ/VOD・YouTube ライブ・mellow-fan)
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

UI は [GitHub Pages](https://kuronekorou39.github.io/chrome-parallel-stream/multiview.html) で配信して
いますが、**そのページを開くだけでは動きません。拡張機能のインストールが必須です。**

配信サイトは `X-Frame-Options` と CSP の `frame-ancestors` で iframe 埋め込みを拒否しており、これを
解除できるのは拡張機能だけです(`rules.json` の declarativeNetRequest)。枠ごとの音量制御・枠内シアター・
弾幕のチャット取得も、拡張機能が枠の中へ注入する content script が担っています。拡張機能なしでは
枠が一つも表示されず、設定も保存されません。

1. このリポジトリをクローンする
2. Chrome で `chrome://extensions` を開き、「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」で、`manifest.json` があるディレクトリを選ぶ
4. ツールバーのアイコン → 「マルチビューを開く」

拡張機能が見つからない状態で UI ページを開いた場合は、画面上部にその旨の警告が出ます。

### 役割分担

| | 担当 |
| --- | --- |
| GitHub Pages | UI(`multiview.html` / `.js` / `.css`)の配信のみ |
| 拡張機能 | CSP / X-Frame-Options の除去、枠内 content script、Cookie 緩和、Kick の再生 URL 取得、設定の保存 |

---

## この拡張がブラウザに与える影響

配信サイトを iframe で並べるという性質上、通常の拡張機能より踏み込んだことをしています。
**インストールする前に理解してください。**

### 1. 対象サイトの CSP と X-Frame-Options を除去します

`rules.json` の declarativeNetRequest ルールで、Twitch / YouTube / Kick / mellow-fan(旧 OPENREC)への **サブフレーム
リクエスト**から `content-security-policy` と `x-frame-options` を削除します。

各サイトは iframe への埋め込みを明示的に拒否しているため、これを外さないとマルチビューは成立しません。
CSP も外しているのは、`frame-ancestors` ディレクティブが同様に埋め込みを拒否するためで、
declarativeNetRequest はヘッダ単位でしか操作できず「そのディレクティブだけ外す」ことができないからです。

適用範囲は `initiatorDomains` で **この拡張の UI ページのオリジンから発したリクエストだけ**に絞って
あります。無関係なサイトがこれらのドメインを埋め込んでも、そちらのヘッダには影響しません。

### 2. 対象サイトの Cookie を `SameSite=None` に書き換えます

枠の中でログイン状態を保つ(チャットに書き込む等)ために、`twitch.tv` / `mellow-fan.com`(旧 `openrec.tv`)/ `kick.com` の
Cookie を `SameSite=None; Secure` へ再設定します。

**副作用:** この変更は拡張のページ内だけでなく、**ブラウザ全体に永続します**。以後これらのサイトへの
クロスサイトリクエストにも Cookie が送られるため、CSRF に対する防御の一枚が外れます
(対象サイト自身の CSRF トークンは有効なままです。また `rules.json` を自分のオリジン発に限定して
あるため、無関係なサイトがこれらを iframe で埋め込むことは各サイトの X-Frame-Options が拒否します)。

**切り替えと復元:** ≡ メニューの「🍪 ログインCookie」から ON/OFF を切り替えられます(既定 ON)。
OFF にすると以後 Cookie には触れません。同じ画面の「変更した Cookie を元に戻す」で、**変更前の
`SameSite` / `Secure` に忠実に戻せます**(変更時の値を記録しています)。

### 3. 枠の中でページの可視状態を偽装します

枠が画面外・バックグラウンドでも再生が止まらないよう、枠の中に限り `document.hidden` /
`visibilityState` / `hasFocus` を「常に可視」で固定し、`visibilitychange` を握り潰します。
通常のタブには影響しません。サイト側の省電力・帯域節約の処理も一緒に無効になります。

### 4. 権限について

`host_permissions` に `<all_urls>` を要求しています。上記のヘッダ操作と、任意の配信ページを枠として
読み込む必要があるためです。`cookies` は 2. のため、`system.cpu` / `system.memory` は
パフォーマンスパネルの表示に使っています。`tabs` はマルチビューのタブを開く/再利用するため、
`storage` は設定の保存のためです。

`activeTab` 以外に任意のページへスクリプトを注入する権限(`scripting`)は要求しません。

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

---

## ライセンス

[MIT](LICENSE)

同梱しているサードパーティコードとその表示は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) を参照してください。
