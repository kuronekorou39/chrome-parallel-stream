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
  // 実際に選ばれた映像コーデックを覚えておき、再生が始まった時点で
  // 「この構成はハードウェアデコードされるのか」を問い合わせて記録する。
  // 2本目の映像が再生を始めた瞬間に落ちているため、デコード経路がハードウェアかどうかで
  // 原因の層(GPU のデコードセッションか、ソフトウェア側か)が分かれる。
  var lastVideoCodec = null;
  var decodeAsked = false;
  hook(window.MediaSource && window.MediaSource.prototype, 'addSourceBuffer', 'MSE.addSourceBuffer', function (t) {
    var s = String(t).slice(0, 80);
    if (s.indexOf('video/') === 0) lastVideoCodec = s;
    return s;
  });
  var askDecodeInfo = function () {
    if (decodeAsked || !lastVideoCodec || !navigator.mediaCapabilities) return;
    decodeAsked = true;
    var v = document.querySelector('video');
    var w = (v && v.videoWidth) || 1280;
    var h = (v && v.videoHeight) || 720;
    try {
      navigator.mediaCapabilities
        .decodingInfo({ type: 'media-source', video: { contentType: lastVideoCodec, width: w, height: h, bitrate: 2000000, framerate: 30 } })
        .then(function (r) {
          send('decodeInfo', lastVideoCodec + ' ' + w + 'x' + h +
            ' supported=' + r.supported + ' smooth=' + r.smooth + ' powerEfficient=' + r.powerEfficient +
            '(true ならハードウェアデコード)');
        }, function (e) { send('decodeInfo失敗', String(e && e.message).slice(0, 100)); });
    } catch (e) { /* noop */ }
  };
  if (window.documentPictureInPicture) hook(window.documentPictureInPicture, 'requestWindow', 'documentPiP.requestWindow');
  if (navigator.gpu) hook(navigator.gpu, 'requestAdapter', 'WebGPU.requestAdapter');
  if (navigator.mediaSession) hook(navigator.mediaSession, 'setActionHandler', 'mediaSession.setActionHandler', function (k) { return String(k); });
  hook(E, 'requestPointerLock', 'requestPointerLock');
  // 注意: hook() は関数を関数でラップして apply で呼ぶ形なので、クラス(Worker など)には使えない。
  // クラスは new 無しで呼べず、ラップした時点でそのページの Worker 生成が全部失敗する
  // (Twitch のプレイヤーが起動しなくなる実害を出した)。必要になったら Proxy の construct で行うこと。

  // canvas のコンテキスト取得。落ちる直前の心拍に必ず getContext:2d が出ていたので、
  // 2d のときだけは「どの canvas か」まで記録する(要素の id/class/大きさ)。
  // 種類の数え上げだけでは、映像を描いている canvas なのか別物なのか区別できない。
  var canvasLeft = 6;
  try {
    var gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      bump('getContext:' + type);
      if (type === '2d' && canvasLeft-- > 0) {
        try {
          send('canvas2d', 'id=' + (this.id || '-') + ' class=' + (this.className || '-').slice(0, 60) +
            ' ' + this.width + 'x' + this.height + ' 親=' + (this.parentElement ? this.parentElement.className || this.parentElement.tagName : '-').slice(0, 60));
        } catch (e2) { /* noop */ }
      }
      return gc.apply(this, arguments);
    };
  } catch (e) { /* noop */ }

  // canvas へ <video> を描いているか(アンビエントモードのように毎フレーム描く機能の検出)。
  // 毎フレーム来るので数えるだけにする。心拍に drawImage(video)=N として出る。
  try {
    var di = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (src) {
      try { if (src && src.tagName === 'VIDEO') bump('drawImage(video)'); } catch (e2) { /* noop */ }
      return di.apply(this, arguments);
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

  // ---- メディア取得(googlevideo)の失敗理由を捕まえる ----
  // 枠が落ちる直前、プレイヤーは MediaSource を作り直して再試行し続けていた。その引き金は
  // 映像データの 403。なぜ断られているのかを知るため、リクエストの素性(クライアント種別・
  // PoToken の有無)と、断り文句の本文を記録する。
  // 注意: 落ちるまでの数秒で何十回も飛ぶので、失敗の記録は上限を設ける。
  var failLeft = 6;
  var bodyLeft = 2;
  var mediaInfo = function (u) {
    try {
      var url = new URL(String(u), location.href);
      if (url.hostname.indexOf('googlevideo.com') === -1) return null;
      var q = url.searchParams;
      var pot = q.get('pot');
      return (
        'path=' + url.pathname +
        ' itag=' + (q.get('itag') || '-') +
        ' c=' + (q.get('c') || '-') +
        ' pot=' + (pot ? pot.length + '文字' : 'なし') +
        (q.get('sabr') ? ' sabr=' + q.get('sabr') : '')
      );
    } catch (e) {
      return null;
    }
  };
  var reportMedia = function (info, status, getBody) {
    if (status >= 200 && status < 300) { bump('media要求OK'); return; }
    if (failLeft-- <= 0) { bump('media要求NG(記録上限)'); return; }
    send('media要求NG', 'status=' + status + ' ' + info);
    if (bodyLeft-- > 0 && getBody) {
      try { getBody(function (t) { send('media要求NG本文', String(t).replace(/\s+/g, ' ').slice(0, 200)); }); } catch (e) { /* noop */ }
    }
  };

  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input) {
        var u = typeof input === 'string' ? input : (input && input.url) || '';
        var info = mediaInfo(u);
        var p = origFetch.apply(this, arguments);
        if (info && p && typeof p.then === 'function') {
          // 元の Promise はそのまま返す。監視用に枝を生やすだけで、呼び出し側の流れは変えない。
          p.then(
            function (r) {
              reportMedia(info, r.status, function (cb) { r.clone().text().then(cb, function () {}); });
            },
            function (e) { send('media要求例外', info + ' / ' + String(e && e.message).slice(0, 120)); }
          );
        }
        return p;
      };
    }
  } catch (e) { /* noop */ }

  try {
    var xo = XMLHttpRequest.prototype.open;
    var xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { this.__mvInfo = mediaInfo(u); } catch (e) { /* noop */ }
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      if (xhr.__mvInfo) {
        xhr.addEventListener('loadend', function () {
          reportMedia(xhr.__mvInfo, xhr.status, function (cb) {
            try { cb(xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : '(本文は非テキスト)'); } catch (e) { /* noop */ }
          });
        });
      }
      return xs.apply(this, arguments);
    };
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
      if (ev === 'playing' && t.tagName === 'VIDEO') askDecodeInfo();
    }, true);
  });

  send('probe.boot', 'top=' + TOP);

  // ---- 心拍。これが途切れた時刻が、そのフレームが落ちた時刻になる ----
  // あわせて、そのフレームがどのプレイヤーとして動いているか(視聴ページ=WEB /
  // 埋め込み=WEB_EMBEDDED_PLAYER)を一度だけ報告する。403 の出方がこれで変わるため。
  var clientReported = false;
  setInterval(function () {
    if (!clientReported) {
      try {
        var c = window.yt && yt.config_ && yt.config_.INNERTUBE_CONTEXT && yt.config_.INNERTUBE_CONTEXT.client;
        if (c && c.clientName) {
          clientReported = true;
          send('client', c.clientName + ' ' + (c.clientVersion || ''));
        }
      } catch (e) { /* noop */ }
    }
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
