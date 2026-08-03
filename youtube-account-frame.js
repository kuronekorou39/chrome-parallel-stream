// YouTube の視聴ページが自分の中に作る accounts.youtube.com の枠を、multiview のタイル内では作らせない。
//
// 視聴ページは accounts.youtube.com を iframe で読み込むが、この枠は
//   frame-ancestors https://www.youtube.com
// で守られている。frame-ancestors は祖先チェーン全体を見るため、
//   multiview(github.io) → www.youtube.com → accounts.youtube.com
// という入れ子では必ず違反になり、ブラウザがその枠を破棄する。普通のタブでは起こらない経路で、
// 枠に入れたときだけ通る。取得したクラッシュログ 5 本すべてでこの違反が出ていた。
//
// 読み込めない枠なので、作らせないこと自体に機能的な損失は無い(表示も動作も変わらない)。
// CSP を剥がして通す手もあるが、それは認証オリジンの防御をブラウザ全体で弱めることになり、
// しかも DNR では「multiview の中のときだけ」に絞れないため採らない。
//
// MAIN world・document_start で入れること(サイトが枠を作る前に構えておく必要がある)。
(function youtubeAccountFrame() {
  'use strict';
  if (window.top === window.self) return; // 通常タブでは何もしない
  try {
    var a = location.ancestorOrigins;
    var top = a && a.length ? a[a.length - 1] : '';
    if (top !== 'https://kuronekorou39.github.io' && top.indexOf('chrome-extension://') !== 0) return;
  } catch (e) {
    return;
  }

  var TARGET = 'accounts.youtube.com';
  var removed = 0;
  var report = function (how) {
    removed++;
    try {
      // crash-probe.js と同じ経路で親へ知らせる(効いているかを記録で確認できるように)。
      window.top.postMessage(
        { __multiviewProbe: true, seq: removed, ms: 0, frame: location.pathname, ev: 'accountFrame止めた', detail: how + ' 累計' + removed },
        '*'
      );
    } catch (e) { /* noop */ }
  };

  var isTarget = function (v) {
    return typeof v === 'string' && v.indexOf(TARGET) !== -1;
  };

  // 1) src を代入された時点で差し替える(読み込みが始まる前に止められる)。
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (d && d.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        enumerable: d.enumerable,
        get: function () { return d.get.call(this); },
        set: function (v) {
          if (isTarget(v)) { report('src代入'); return d.set.call(this, 'about:blank'); }
          return d.set.call(this, v);
        },
      });
    }
  } catch (e) { /* noop */ }

  // 2) setAttribute('src', ...) 経由も同じ扱いにする。
  try {
    var sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this.tagName === 'IFRAME' && String(name).toLowerCase() === 'src' && isTarget(value)) {
        report('setAttribute');
        return sa.call(this, name, 'about:blank');
      }
      return sa.apply(this, arguments);
    };
  } catch (e) { /* noop */ }

  // 3) 取りこぼし対策。すり抜けて DOM に入ったものは見つけ次第外す。
  try {
    var sweep = function (root) {
      var list = root.querySelectorAll ? root.querySelectorAll('iframe[src*="' + TARGET + '"]') : [];
      for (var i = 0; i < list.length; i++) {
        try { list[i].remove(); report('DOMから除去'); } catch (e) { /* noop */ }
      }
    };
    new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var added = recs[i].addedNodes;
        for (var k = 0; k < added.length; k++) {
          var n = added[k];
          if (!n || n.nodeType !== 1) continue;
          if (n.tagName === 'IFRAME' && isTarget(n.getAttribute('src'))) {
            try { n.remove(); report('挿入時に除去'); } catch (e) { /* noop */ }
          } else {
            sweep(n);
          }
        }
      }
    }).observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (e) { /* noop */ }
})();
