// player.twitch.tv(軽量モードの埋め込みプレイヤー)で、画面外でも再生を続けさせる。
//
// Twitch の埋め込みプレイヤーは「ビューポートに50%以上見えていないと自動再生を止める」可視性
// ウォッチドッグ(detectVisibilityViolation → "Autoplay disabled ... style visibility")を内蔵する。
// 縦積みでスクロールするとタイルが画面外になり、これに引っかかって止まる。
//
// クロスオリジンの埋め込みが「親ビューポートでの自分の可視状態」を知る手段は実質 IntersectionObserver と
// Page Visibility API だけなので、その両方を「常に完全可視」と思い込ませて停止を防ぐ。
// MAIN world・document_start で、Twitch のスクリプトが観測を始める前に差し替える。
(function twitchKeepAlive() {
  'use strict';
  if (window.top === window.self) return; // 埋め込み(iframe)内のみ。トップレベルでは通常動作のまま

  // 1) IntersectionObserver を「観測対象は常に完全交差(可視)」を報告する版へ差し替える。
  // ネイティブの root/rootMargin/thresholds はゲッター専用なので、prototype を継承せず
  // プレーンオブジェクトで API を実装する(代入で例外を出さないため)。
  const RealIO = window.IntersectionObserver;
  if (typeof RealIO === 'function') {
    const Patched = function (cb, options) {
      try {
        const targets = new Set();
        const entryFor = function (t) {
          let r;
          try {
            r = t.getBoundingClientRect();
          } catch (e) {
            r = { top: 0, left: 0, bottom: 1, right: 1, width: 1, height: 1, x: 0, y: 0 };
          }
          return {
            target: t, isIntersecting: true, intersectionRatio: 1,
            boundingClientRect: r, intersectionRect: r, rootBounds: r, time: Date.now()
          };
        };
        const notify = function (t) { try { cb([entryFor(t)], api); } catch (e) { /* noop */ } };
        const api = {
          root: (options && options.root) || null,
          rootMargin: (options && options.rootMargin) || '0px',
          thresholds: [0],
          observe: function (t) {
            targets.add(t);
            Promise.resolve().then(function () { if (targets.has(t)) notify(t); });
          },
          unobserve: function (t) { targets.delete(t); },
          disconnect: function () { targets.clear(); },
          takeRecords: function () { return []; }
        };
        // Twitch は監視し続けるので、可視を定期的に再通知する。
        setInterval(function () { targets.forEach(notify); }, 1000);
        return api;
      } catch (e) {
        return new RealIO(cb, options); // 何かあれば本物にフォールバック(プレイヤーを壊さない)
      }
    };
    try { window.IntersectionObserver = Patched; } catch (e) { /* noop */ }
  }

  // 2) Page Visibility を常に「可視」へ偽装(タブが裏でも止めない)。visibilitychange の hidden も握り潰す。
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: function () { return 'visible'; } });
  } catch (e) { /* noop */ }
  const swallow = function (e) { e.stopImmediatePropagation(); };
  document.addEventListener('visibilitychange', swallow, true);
  document.addEventListener('webkitvisibilitychange', swallow, true);

  // 3) フォーカス喪失で止める実装にも備え、hasFocus も true に固定。
  try { document.hasFocus = function () { return true; }; } catch (e) { /* noop */ }
})();
