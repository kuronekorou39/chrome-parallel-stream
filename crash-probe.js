// 枠(iframe)の中で何が起きてからレンダラが落ちたのかを記録するための計測用スクリプト。
//
// 枠が落ちるとその文書のコンソールごと消えるため、枠の中に console.log を置いても何も残らない。
// そこで、枠の中で起きたことを window.top(= multiview のページ。別プロセスなので生き残る)へ
// postMessage で逐次送り出し、記録は親側に任せる。最後に届いた行の直後が落ちた瞬間になる。
//
// MAIN world・document_start で入れること。サイトのスクリプトが動き出す前に差し替える必要がある。
// 計測が目的なので、フックした API は必ず元の実装をそのまま呼び、戻り値も素通しする。
(function crashProbe() {
  'use strict';
  if (window.top === window.self) return; // 枠の中だけ
  // 自分の枠(multiview)でのみ動かす。無関係なサイトの埋め込みを覗かないため。
  var TOP;
  try {
    var a = location.ancestorOrigins;
    TOP = a && a.length ? a[a.length - 1] : '';
    if (TOP !== 'https://kuronekorou39.github.io' && TOP.indexOf('chrome-extension://') !== 0) return;
  } catch (e) {
    return;
  }

  var MAGIC = '__multiviewProbe';
  var t0 = Date.now();
  // 枠の中のどのフレームか(視聴ページ本体か live_chat 等の入れ子か)を親が区別できるようにする。
  var FRAME = location.pathname + (location.search ? location.search.slice(0, 40) : '');
  var seq = 0;

  var send = function (ev, detail) {
    try {
      window.top.postMessage(
        { __multiviewProbe: true, seq: ++seq, ms: Date.now() - t0, frame: FRAME, ev: ev, detail: detail },
        '*'
      );
    } catch (e) { /* noop */ }
  };

  // 呼ばれた回数だけ知りたいもの(可視性の読み取りなど毎秒何十回も来る)は、
  // 1件ずつ送らずに数えておき、心拍でまとめて送る。ログが流量で潰れるのを防ぐ。
  var counts = Object.create(null);
  var bump = function (k) { counts[k] = (counts[k] || 0) + 1; };

  // ---- 落ちる直前に呼ばれがちな API を、呼ばれた事実だけ記録する ----
  // 「可視でないと許されない」種類の API を中心に見る。可視性を偽装しているため、
  // ページが実際には可視でない状態でこれらを呼び、ブラウザ側の検査に当たる筋を疑っている。
  var hook = function (obj, name, label, pick) {
    try {
      if (!obj || typeof obj[name] !== 'function') return;
      var orig = obj[name];
      obj[name] = function () {
        try { send(label, pick ? pick.apply(this, arguments) : undefined); } catch (e) { /* noop */ }
        return orig.apply(this, arguments);
      };
    } catch (e) { /* noop */ }
  };

  var V = window.HTMLVideoElement && window.HTMLVideoElement.prototype;
  var M = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  var E = window.Element && window.Element.prototype;

  hook(V, 'requestPictureInPicture', 'requestPictureInPicture');
  hook(E, 'requestFullscreen', 'requestFullscreen');
  hook(document, 'exitFullscreen', 'exitFullscreen');
  hook(document, 'exitPictureInPicture', 'exitPictureInPicture');
  hook(M, 'play', 'media.play', function () { return this.tagName + ' rs=' + this.readyState; });
  hook(M, 'load', 'media.load');
  hook(navigator, 'requestMediaKeySystemAccess', 'EME.requestMediaKeySystemAccess', function (ks) { return String(ks); });
  hook(window.MediaSource && window.MediaSource.prototype, 'addSourceBuffer', 'MSE.addSourceBuffer', function (t) { return String(t).slice(0, 60); });
  if (window.documentPictureInPicture) hook(window.documentPictureInPicture, 'requestWindow', 'documentPiP.requestWindow');
  if (navigator.gpu) hook(navigator.gpu, 'requestAdapter', 'WebGPU.requestAdapter');
  if (navigator.mediaSession) hook(navigator.mediaSession, 'setActionHandler', 'mediaSession.setActionHandler', function (k) { return String(k); });
  hook(E, 'requestPointerLock', 'requestPointerLock');
  // 注意: hook() は関数を関数でラップして apply で呼ぶ形なので、クラス(Worker など)には使えない。
  // クラスは new 無しで呼べず、ラップした時点でそのページの Worker 生成が全部失敗する
  // (Twitch のプレイヤーが起動しなくなる実害を出した)。必要になったら Proxy の construct で行うこと。

  // canvas のコンテキスト取得は種類だけ記録(webgl/webgpu は落ち方に絡みやすい)
  try {
    var gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      bump('getContext:' + type);
      return gc.apply(this, arguments);
    };
  } catch (e) { /* noop */ }

  // appendBuffer は毎秒何度も来るので数えるだけ
  try {
    if (window.SourceBuffer) {
      var ab = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (buf) {
        bump('appendBuffer');
        try { counts.appendBytes = (counts.appendBytes || 0) + (buf && buf.byteLength ? buf.byteLength : 0); } catch (e) { /* noop */ }
        return ab.apply(this, arguments);
      };
    }
  } catch (e) { /* noop */ }

  // ---- ページ自身のエラーも拾う ----
  window.addEventListener('error', function (e) {
    send('window.error', String(e.message || '').slice(0, 160));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    send('unhandledrejection', String((e.reason && e.reason.message) || e.reason || '').slice(0, 160));
  });
  document.addEventListener('fullscreenchange', function () { send('fullscreenchange', String(!!document.fullscreenElement)); }, true);
  document.addEventListener('enterpictureinpicture', function () { send('enterPiP'); }, true);

  // メディア要素の状態遷移(落ちる直前がどの段階かを見る)
  ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'error', 'emptied', 'ended'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var t = e.target;
      if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
      send('media.' + ev, 'rs=' + t.readyState + ' ns=' + t.networkState + (t.error ? ' err=' + t.error.code : ''));
    }, true);
  });

  send('probe.boot', 'top=' + TOP);

  // ---- 心拍。これが途切れた時刻が、そのフレームが落ちた時刻になる ----
  setInterval(function () {
    var v = document.querySelector('video');
    var acc = counts;
    counts = Object.create(null);
    var parts = [];
    for (var k in acc) parts.push(k + '=' + acc[k]);
    var vs = '';
    try { vs = ' vis=' + document.visibilityState; } catch (e) { /* noop */ }
    send('beat', (v ? 'video×' + document.querySelectorAll('video').length + ' rs=' + v.readyState + ' t=' + v.currentTime.toFixed(1) + (v.paused ? ' paused' : '') : 'video無し') +
      vs + (parts.length ? ' | ' + parts.join(' ') : ''));
  }, 1000);
})();
