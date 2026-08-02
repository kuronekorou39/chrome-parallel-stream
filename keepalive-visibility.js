// 配信サイトのフレームで、タブ/アプリが裏に回っても「常に可視」と思い込ませ、サイトの自発停止を防ぐ。
//
// twitch-keepalive.js は player.twitch.tv(軽量埋め込み)専用で IntersectionObserver も差し替えるが、
// multiview が実際に読むのは www.twitch.tv/<channel> や youtube.com/watch・live で、そこには
// Page Visibility 偽装が効いていなかった。YouTube は特に未対策。
// このスクリプトは youtube.com / twitch.tv / openrec.tv の各フレームに広く効かせる「visibility 偽装」だけを担う。
//
// MAIN world・document_start で、サイトのスクリプトが Page Visibility を観測し始める前に差し替えること。
// (ISOLATED world だと document.hidden の上書きがページ側に伝わらないため MAIN world 必須)
(function keepaliveVisibility() {
  'use strict';
  if (window.top === window.self) return; // multiview のタイル(iframe)内のみ。通常タブの背面挙動は変えない。

  // Page Visibility を常に「可視」へ固定する。サイトは document.hidden / visibilityState を見て
  // タブが裏になると video.pause()/スロットルするため、ここを偽装して停止トリガを断つ。
  // ネイティブのプロパティはアクセサなので defineProperty で差し替える(configurable:true で冪等)。
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: function () { return 'visible'; } });
  } catch (e) { /* noop */ }

  // visibilitychange(と webkit 版)はキャプチャ段で握り潰し、サイトのリスナまで届かせない。
  const swallow = function (e) { e.stopImmediatePropagation(); };
  document.addEventListener('visibilitychange', swallow, true);
  document.addEventListener('webkitvisibilitychange', swallow, true);

  // フォーカス喪失で止める実装にも備え、hasFocus を true 固定。
  try { document.hasFocus = function () { return true; }; } catch (e) { /* noop */ }

  // ---- 広告ブロックがこの枠に効いているかを親へ知らせる ----
  // 広告ブロックは別拡張(chrome-ad-skipper)の担当。枠は別オリジンなので拡張ページ側から
  // 中を覗けず、効いているかどうかを利用者が確認する手段が無い。vaft が立てる
  // window.twitchAdSolutionsVersion を MAIN world のここから読んで親へ送り、枠のバッジに出す。
  // 別拡張なので注入の順序もタイミングも保証されない。数回に分けて確認し、変化時だけ報告する。
  if (location.hostname.indexOf('twitch.tv') !== -1) {
    var reported;
    var reportAdblock = function () {
      var v = window.twitchAdSolutionsVersion;
      var state = { vaft: typeof v === 'number' ? v : null, host: location.hostname };
      var key = JSON.stringify(state);
      if (key === reported) return;
      reported = key;
      try {
        // '__multiviewControl' は stream-control.js / multiview.js の MAGIC と一致させること。
        window.parent.postMessage({ __multiviewControl: true, type: 'adblock-state', state: state }, '*');
      } catch (e) { /* noop */ }
    };
    [500, 1500, 3000, 6000, 10000].forEach(function (ms) { setTimeout(reportAdblock, ms); });
  }
})();
