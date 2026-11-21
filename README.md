<div align="center">

<img src="icon-128.png" width="96" height="96" alt="Parallel Stream のアイコン">

# Parallel Stream

**Twitch / YouTube / mellow-fan(旧 OPENREC) / Kick の配信を、1画面に並べて同時に見るための Chrome 拡張機能**

![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?style=flat-square)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![hls.js](https://img.shields.io/badge/hls.js-0A7EA4?style=flat-square)
![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-222222?style=flat-square&logo=githubpages&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)

</div>

---

## PC

サイトを選ぶか URL を貼って、枠を1つずつ足していきます。

**枠を追加** — 右下の `＋` から、サイトのボタンか URL で

<img src="docs/images/01-empty.jpg" alt="枠がまだ無い状態。左下に ≡ メニュー、右下に丸ボタン(整列・一覧・追加)と「枠を追加」ダイアログ">

**4枠** — 枠一覧で音量、配置パネルで整列

<img src="docs/images/03-four.jpg" alt="4枠を並べた状態。右上に枠一覧と配置パネル">

**さらに追加** — 大きさと位置は枠ごとに自由

<img src="docs/images/04-many.jpg" alt="7枠を並べた状態">

## スマホ

枠を縦に積んで見ます。

| 空の状態 | 2枠(Twitch と YouTube) |
| :---: | :---: |
| <img src="docs/images/05-mobile-empty.jpg" width="260" alt="スマホで枠がまだ無い状態。左下に ≡ メニュー、右下に一覧と追加の丸ボタン"> | <img src="docs/images/06-mobile-two.jpg" width="260" alt="スマホで Twitch と YouTube の2枠を縦に積んで再生している状態"> |

---

## できること

- 配信をいくつでも並べて、大きさと位置を自由に決める
- 枠ごとに音量を変える(全部まとめても)
- コメントを映像の上に流す(弾幕)
- 同じ配信を映している枠どうし(本配信と、そのミラー配信など)の時間のずれを揃える。
  音を聞き比べて自動で合わせるほか、枠ごとに 0.1 秒単位で手で遅らせることもできる(Twitch のライブのみ)
- 並べ方に名前を付けて保存し、あとで呼び出す
- スマホでは縦に積んで見る

---

## 広告のスキップ

広告をスキップする機能は、この拡張機能には入っていません。
別の拡張機能 **[広告スキッパー(chrome-ad-skipper)](https://github.com/kuronekorou39/chrome-ad-skipper)** を一緒に入れると、並べた枠の中でも広告のスキップが効きます。

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://github.com/kuronekorou39/chrome-ad-skipper/tree/main/packages/extension-twitch"><img src="docs/images/ad-skipper-twitch.png" width="64" height="64" alt="広告スキッパー for Twitch のアイコン"></a><br>
      <strong><a href="https://github.com/kuronekorou39/chrome-ad-skipper/tree/main/packages/extension-twitch">広告スキッパー for Twitch</a></strong>
    </td>
    <td align="center" width="50%">
      <a href="https://github.com/kuronekorou39/chrome-ad-skipper/tree/main/packages/extension-youtube"><img src="docs/images/ad-skipper-youtube.png" width="64" height="64" alt="広告スキッパー for YouTube のアイコン"></a><br>
      <strong><a href="https://github.com/kuronekorou39/chrome-ad-skipper/tree/main/packages/extension-youtube">広告スキッパー for YouTube</a></strong>
    </td>
  </tr>
</table>

---

## インストール

1. **[ZIP をダウンロード](https://kuronekorou39.github.io/chrome-parallel-stream/dist/parallel-stream-1.0.0.zip)**して、右クリック →「すべて展開」でフォルダを取り出す
2. Chrome のアドレスバーに `chrome://extensions` と入れて開く
3. 右上の「**デベロッパー モード**」を ON にする
4. 左上に出てくる「**パッケージ化されていない拡張機能を読み込む**」を押して、1 で展開したフォルダを選ぶ
5. Chrome 右上のパズルのアイコン → **Parallel Stream** → 「**マルチビューを開く**」

これで使えます。更新するときは、新しい ZIP を落として同じ手順でフォルダを選び直してください
(アプリの `≡` メニュー →「拡張機能」から、新しい版が出ているか確認できます)。

---

## インストールする前に

配信サイトを並べるために、この拡張はブラウザに踏み込んだ変更をします。
なかでも **Cookie の変更はブラウザ全体に残ります**(設定で元に戻せます)。

何をどこまで変えるかは **[ブラウザに与える影響](docs/browser-impact.md)** に書いてあります。
**読んでから入れてください。**

---

## ライセンス

[MIT](LICENSE)

同梱しているサードパーティコードとその表示は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) を参照してください。
