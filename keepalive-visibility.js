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

  // ---- 診断: 広告ブロッカーがこの枠に入っているかを親へ知らせる ----
  // 広告ブロックは別拡張(chrome-ad-skipper)の担当だが、枠は別オリジンなので
  // 拡張ページ側から中を覗けず、「入っているのに効かない」のか「そもそも入っていない」のかを
  // 切り分けられない。vaft が立てる window.twitchAdSolutionsVersion を MAIN world のここから
  // 読んで親へ送り、枠のバッジに出す。
  // 別拡張なので注入順は保証されない。数回に分けて確認し、状態が変わったときだけ報告する。
  if (location.hostname.indexOf('twitch.tv') !== -1) {
    // vaft が居ない場合の切り分け用に、広告スキッパーの別スクリプト(page-script が window.fetch を
    // 差し替える)が届いているかも一緒に見る。fetch だけ差し替わっていれば「その拡張の MAIN world は
    // 枠に届いているが vaft だけ動いていない」、両方無ければ「その拡張自体が枠に届いていない」。
    var isPatched = function (fn) {
      try { return !/\[native code\]/.test(Function.prototype.toString.call(fn)); } catch (e) { return false; }
    };
    var reported;
    var reportAdblock = function () {
      var v = window.twitchAdSolutionsVersion;
      var state = {
        vaft: typeof v === 'number' ? v : null,
        fetchHooked: isPatched(window.fetch),
        workerHooked: isPatched(window.Worker),
        // 広告スキッパーが vaft と同条件で入れている最小マーカー。
        // これが有るのに vaft が無ければ「注入枠は届いているが vaft 固有の理由で走っていない」。
        marker: !!window.__adSkipperMarker,
        // page-script 自身の印。fetch の差し替えは Twitch 自身も行うため判定に使えない。
        pageMarker: !!window.__adSkipperPageMarker,
        host: location.hostname
      };
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
