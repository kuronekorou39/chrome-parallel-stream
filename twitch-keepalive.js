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
  // 自分の枠の中だけに限定する。無関係なサイトが player.twitch.tv を埋め込んでいる場合にまで
  // 可視性を偽装すると、そのサイトの省電力・自動停止まで壊してしまう。
  try {
    const a = location.ancestorOrigins;
    const top = a && a.length ? a[a.length - 1] : '';
    if (top !== 'https://kuronekorou39.github.io' && top.indexOf('chrome-extension://') !== 0) return;
  } catch (e) {
    return;
  }

  // 1) IntersectionObserver を「観測対象は常に完全交差(可視)」を報告する版へ差し替える。
  // ネイティブの root/rootMargin/thresholds はゲッター専用なので、prototype を継承せず
  // プレーンオブジェクトで API を実装する(代入で例外を出さないため)。
  const RealIO = window.IntersectionObserver;
  if (typeof RealIO === 'function') {
    // 再通知タイマーは Observer ごとではなく全体で1本にする。Twitch は SPA でプレイヤーを
    // 作り直すたびに Observer を生成するため、インスタンスごとに setInterval を張ると
    // 視聴時間に比例して積み上がる(解除する経路も無かった)。
    const live = new Set();
    let timer = null;
    const ensureTimer = function () {
      if (timer !== null) return;
      timer = setInterval(function () {
        if (live.size === 0) { clearInterval(timer); timer = null; return; }
        live.forEach(function (tick) { tick(); });
      }, 1000);
    };

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
            live.add(tick);
            ensureTimer();
            Promise.resolve().then(function () { if (targets.has(t)) notify(t); });
          },
          unobserve: function (t) {
            targets.delete(t);
            if (targets.size === 0) live.delete(tick);
          },
          disconnect: function () { targets.clear(); live.delete(tick); },
          takeRecords: function () { return []; }
        };
        // Twitch は監視し続けるので、可視を定期的に再通知する(タイマーは全体で1本を共有)。
        function tick() { targets.forEach(notify); }
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
