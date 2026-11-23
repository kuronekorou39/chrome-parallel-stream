# 設計メモ

素の JavaScript のみで、ビルド不要・npm 依存なしです(Manifest V3)。
Kick の配信は、公式プレイヤー(`player.kick.com`)と popout チャットの2枚組で表示しています
(再生リストの CORS が Kick の許可オリジンにしか開いておらず、UI ページから HLS を直接読めないため)。

## UI ページを通常のオリジンに置いている理由

マルチビューの UI は、拡張ページ(`chrome-extension://`)ではなく通常の https ページとして配信しています
(GitHub Pages)。拡張ページ版も同梱していて同じように動きますが、既定では通常ページ版を開きます。

理由は Chrome の仕様です。**拡張ページの中にある iframe には、他の拡張の content script が一切注入
されません。** 宣言的な `content_scripts` も `chrome.scripting.executeScript` も通らず、後者は
`Cannot access contents of the page` で失敗します。そのため拡張ページ版では、広告スキッパーのような
他の拡張が枠の中でまったく効きません。UI を通常のオリジンに置くと、枠は「普通のウェブページの中の
iframe」になり、他の拡張が問題なく動くようになります。

なお広告ブロックはこのリポジトリには含まれません。別プロジェクト
[chrome-ad-skipper](https://github.com/kuronekorou39/chrome-ad-skipper) の担当で、両方を入れると
枠の中でも広告スキップが効きます。

## ページ ⇔ 拡張の橋渡し

ページから拡張の機能(設定の保存、Cookie 緩和、Kick の再生 URL 取得など)を使うために、
`ext-bridge.js`(ページ側)と `page-bridge.js`(content script)が `postMessage` で橋渡しをしています。
`multiview.js` は `chrome.*` を直接呼ばず、`MV.*` 経由で統一しています。

| | 担当 |
| --- | --- |
| GitHub Pages | UI(`multiview.html` / `.js` / `.css`)の配信のみ |
| 拡張機能 | X-Frame-Options の除去、枠内 content script、Cookie 緩和、Kick の再生 URL 取得、設定の保存 |

## ブランチと公開

| ブランチ | 役割 |
| --- | --- |
| `main` | 作業用。ここへ push しても利用者には何も届かない |
| `release` | 公開用。**GitHub Pages はこのブランチを配る** |

UI は GitHub Pages から配っているので、`main` に push した時点で公開してしまうと、利用者の
画面が作業のたびに変わり、「拡張機能が古い」の表示も毎回出る。公開する時だけ `release` を
進める。

```
git push origin main:release   # これを実行した時だけ、利用者に届く
```

作業中の UI を自分で確かめるときは、`node tools/publish.mjs dev` で `release` の中の `dev/` へ
写し、`https://kuronekorou39.github.io/chrome-parallel-stream/dev/multiview.html` を開く。
利用者が見るのはルート側なので、ここを更新しても届かない。

拡張機能に同梱されている `chrome-extension://<拡張ID>/multiview.html?dev=1` でも開けるが
(`?dev=1` が無いと Pages へ転送される)、Twitch の枠は映らない。埋め込みプレイヤーは `parent=` に
渡したホスト名でしか埋め込みを許可せず、拡張ページのオリジンはそれに当てはまらないため。
枠の中で他の拡張(広告スキッパー)も効かない。

## リリース

`node tools/release.mjs` で版を上げ、配布用の ZIP を `dist/` に作ります。版番号は
`manifest.json` / `multiview.html` の `?v=`(GitHub Pages のキャッシュ避け)/ `multiview.js` の
`EXPECTED_EXT_VERSION` の3か所にあり、手で合わせるとずれるのでこのスクリプトで一括して書き換えます。

UI ファイル(`multiview.*` / `ext-bridge.js`)を変えたら**必ず版を上げてください**。`?v=` が据え置きだと
GitHub Pages のキャッシュが効いて、古い JS/CSS のまま配られます。
