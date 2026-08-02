# サードパーティコードの表示

このリポジトリ本体は [MIT ライセンス](LICENSE) です。以下のファイルは第三者の著作物を同梱したもので、
それぞれ元のライセンスが適用されます。

## hls.js (`hls.min.js`, `hls.worker.js`)

- バージョン: 1.5.18
- 出所: https://github.com/video-dev/hls.js
- ライセンス: Apache License, Version 2.0
- ライセンス全文: [`third_party/hls.js/LICENSE`](third_party/hls.js/LICENSE)
- 著作権表示: Copyright (c) 2017 Dailymotion (http://www.dailymotion.com) /
  Copyright (c) 2013-2015 Brightcove

用途: Kick の配信を HLS (m3u8) で直接再生するために使用しています
(`multiview.js` の `setupKickVideo` / `playHls`)。

**改変について:** 同梱している配布物は上流のビルド成果物ですが、**先頭のライセンスバナーが
除去された状態で取り込まれていました**。現在は出所とライセンスを示すヘッダコメントを各ファイルの
先頭に付け直しています。コード自体には変更を加えていません。
