// player.twitch.tv(軽量モードの埋め込みプレイヤー)で、画面外でも再生を続けさせる。
//
// Twitch の埋め込みプレイヤーは「ビューポートに50%以上見えていないと自動再生を止める」可視性
// ウォッチドッグ(detectVisibilityViolation → "Autoplay disabled ... style visibility")を内蔵する。
// 縦積みでスクロールするとタイルが画面外になり、これに引っかかって止まる。
//
// クロスオリジンの埋め込みが「親ビューポートでの自分の可視状態」を知る手段は実質 IntersectionObserver と
// Page Visibility API だけなので、その両方を「常に完全可視」と思い込ませて停止を防ぐ。
// MAIN world・document_start で、Twitch のスクリプトが観測を始める前に差し替える。
//
// 同じく MAIN world でしかできないこととして、枠ごとの遅延(下の 4)もここが担当する。
// 遅延を自動で決めるための音の取り出し(下の 5)も、遅延と組なのでここに置いている。
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

  // 4) 枠ごとの遅延(親からの set-delay)。本配信とミラー配信を並べたときに、進んでいる側を
  // 遅らせて音を揃えるためのもの。
  //
  // 遅延は「再生位置をライブ先端から後ろへずらす」ことで作る。一時停止では作れない
  // (止めた時点でプレイヤーがバッファを捨て、再開するとライブ先端から読み直すため。実測)。
  // 手段は2つ:
  //   - currentTime を直接動かす … 一瞬で変わるが、切り替わりで音が途切れる。大きな変更用
  //   - playbackRate を一時的に変える … 途切れない。0.1 秒単位の微調整用
  // プレイヤーは playbackRate を 1.03 にしてライブ先端へ追いつこうとするので、遅延中は
  // ページ側からの書き込みを握り潰す(これをしないと、作った遅延が数分で消える)。
  // 握り潰すにはページと同じ世界に居る必要があるため、content script(stream-control.js)では
  // なく MAIN world のここに置いている。
  const MAGIC = '__multiviewControl'; // stream-control.js / multiview.js と一致させること
  const DELAY_MAX_SEC = 20; // multiview.js の DELAY_MAX_SEC と合わせる(戻れるバッファは約30秒)
  const DELAY_TICK_MS = 100;
  const DELAY_SEEK_SETTLE_MS = 1500; // シーク直後は再生が落ち着くまで触らない
  const DELAY_JUMP_SEC = 3; // これ以上の不連続は、プレイヤー側の読み直し/シークとみなす
  const rateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');

  let delayTarget = 0;   // 親が指定した遅延(秒)。0 = 何もしない
  let delayVideo = null; // 速度の書き込みを握っている <video>
  let delayRate = 1;     // こちらが最後に当てた速度
  let delayRef = null;   // 基準点 { wall, media }。ここから等速で進んだ位置との差が「今の遅延」
  let delayLast = null;  // 前回の観測 { wall, media, rate }(不連続の検出用)
  let delaySeekAt = -Infinity;
  let delayTimer = null;
  let delayReported = '';

  // ずれ err(= 目標 - 今の遅延。正なら「もっと遅らせる」)と、再生位置の前後にあるバッファ量から
  // 次の一手を決める。{ rate } か { seek: 動かす秒数 } を返す。
  function mvDelayPlan(err, ahead, back) {
    const DEAD_BAND = 0.03;  // これ以内は合っているとみなす
    const FINE_MAX = 0.6;    // これ以下は速度で詰める(シークは音が途切れるため)
    const NUDGE = 0.2;       // 微調整の速度の振れ幅(0.8 倍 / 1.2 倍)
    const BUILD_RATE = 0.25; // 戻れるバッファが無いとき、遅延を溜める速度
    const MIN_AHEAD = 1;     // 先読みをこれ未満にしない(詰めすぎると止まる)
    const BACK_MARGIN = 0.5; // バッファの始端ぎりぎりへは戻らない
    if (Math.abs(err) <= DEAD_BAND) return { rate: 1 };
    if (err > 0) {
      if (err <= FINE_MAX) return { rate: 1 - NUDGE };
      if (back - err >= BACK_MARGIN) return { seek: -err };
      return { rate: BUILD_RATE };
    }
    const room = ahead - MIN_AHEAD; // ライブ先端へ向けて進める余地
    if (room <= 0) return { rate: 1 };
    if (-err <= FINE_MAX || room < FINE_MAX) return { rate: 1 + NUDGE };
    return { seek: Math.min(-err, room) };
  }

  function delaySetRate(v, r) {
    if (delayRate === r) return;
    delayRate = r;
    try { rateDesc.set.call(v, r); } catch (e) { /* noop */ }
  }
  function delayLock(v) {
    try {
      Object.defineProperty(v, 'playbackRate', {
        configurable: true,
        get: function () { return rateDesc.get.call(v); },
        set: function () { /* 遅延中はプレイヤーの追いつき(1.03倍)を通さない */ }
      });
    } catch (e) { /* noop */ }
    delayRate = rateDesc.get.call(v);
  }
  function delayUnlock(v) {
    if (!v) return;
    try { delete v.playbackRate; rateDesc.set.call(v, 1); } catch (e) { /* noop */ }
  }
  // 再生位置を含むバッファ範囲から、前後の残量を出す。
  function delayRoom(v) {
    const b = v.buffered;
    const t = v.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.1 && t <= b.end(i) + 0.1) return { ahead: b.end(i) - t, back: t - b.start(i) };
    }
    return null;
  }
  function delayReport(actual, settled) {
    const state = { target: delayTarget, actual: Math.round(actual * 10) / 10, settled: settled };
    const key = JSON.stringify(state);
    if (key === delayReported) return;
    delayReported = key;
    try { window.parent.postMessage({ [MAGIC]: true, type: 'delay-state', state: state }, '*'); } catch (e) { /* noop */ }
  }

  function delayTick() {
    const v = document.querySelector('video');
    if (v !== delayVideo) { // プレイヤーの作り直しで <video> が替わった
      delayUnlock(delayVideo);
      delayVideo = v;
      delayRef = null;
      delayLast = null;
      if (v) delayLock(v);
    }
    if (!v) return;
    const now = performance.now();
    const media = v.currentTime;
    if (v.paused || v.seeking || v.readyState < 3) { delayLast = null; return; } // 止まっている間は触らない

    // プレイヤー側の読み直し/シークで時間軸が飛んだら、基準点を取り直す(遅延は作り直しになる)。
    if (delayLast && now - delaySeekAt > DELAY_JUMP_SEC * 1000) {
      const expected = ((now - delayLast.wall) / 1000) * delayLast.rate;
      if (Math.abs(media - delayLast.media - expected) > DELAY_JUMP_SEC) delayRef = null;
    }
    if (!delayRef) delayRef = { wall: now, media: media };
    let shift = (now - delayRef.wall) / 1000 - (media - delayRef.media);
    if (shift < -DELAY_JUMP_SEC || shift > DELAY_MAX_SEC + 5 * DELAY_JUMP_SEC) { // 取りこぼした不連続の保険
      delayRef = { wall: now, media: media };
      shift = 0;
    }
    delayLast = { wall: now, media: media, rate: delayRate };

    const err = delayTarget - shift;
    delayReport(shift, Math.abs(err) <= 0.1);
    if (now - delaySeekAt < DELAY_SEEK_SETTLE_MS) return;
    const room = delayRoom(v);
    if (!room) return;
    const plan = mvDelayPlan(err, room.ahead, room.back);
    if (plan.seek) {
      delaySetRate(v, 1);
      delaySeekAt = now;
      try { v.currentTime = media + plan.seek; } catch (e) { /* noop */ }
    } else {
      delaySetRate(v, plan.rate);
    }
  }

  function delayStop() {
    if (delayTimer !== null) { clearInterval(delayTimer); delayTimer = null; }
    const v = delayVideo;
    if (v && delayRef && !v.paused) {
      // 溜めた遅延を返す。進める余地があるぶんだけ先端側へ飛び、残りはプレイヤーの追いつきに任せる。
      const shift = (performance.now() - delayRef.wall) / 1000 - (v.currentTime - delayRef.media);
      const room = delayRoom(v);
      const fwd = room ? Math.min(shift, room.ahead - 1) : 0;
      if (fwd > 0.1) { try { v.currentTime += fwd; } catch (e) { /* noop */ } }
    }
    delayUnlock(v);
    delayVideo = null;
    delayRef = null;
    delayLast = null;
    delayReport(0, true);
  }

  // 読み直し(広告明け・画質切替・一時停止からの再開)では時間軸が 0 から始まり直す。
  // メディアイベントはバブルしないので capture で拾う。
  document.addEventListener('emptied', function (e) {
    if (e.target === delayVideo) { delayRef = null; delayLast = null; }
  }, true);

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return; // 親(multiview)以外からの偽装を弾く
    const d = e.data;
    if (!d || d[MAGIC] !== true || d.type !== 'set-delay') return;
    const t = Math.max(0, Math.min(DELAY_MAX_SEC, Number(d.value) || 0));
    if (t === delayTarget) return;
    delayTarget = t;
    if (t <= 0) { delayStop(); return; }
    if (delayTimer === null) delayTimer = setInterval(delayTick, DELAY_TICK_MS);
  });

  // 5) 音合わせ用に、いま鳴っている音を親へ渡す(親からの sync-listen)。
  // 親は複数の枠の音を突き合わせて枠同士のずれを測り、上の遅延で揃える。枠は別オリジンなので
  // 親からは音に触れず、ここで取り出して送るしかない。
  // 取り出しは captureStream(再生している音の複製)。ミュート中や音量 0 でも取れ、再生にも
  // 影響しない(実測)。AudioContext を使わないのは、操作されていない枠では自動再生の制限で
  // 止まったままになるため。突き合わせに高い音は要らないので、4kHz 相当まで間引いて送る。
  const SYNC_RATE = 4000;
  const SYNC_BATCH_SEC = 0.5; // 親へ送る間隔
  let syncStop = null;

  function syncPost(msg) {
    msg[MAGIC] = true;
    msg.type = 'sync-audio';
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* noop */ }
  }

  function syncStart() {
    if (syncStop) return;
    const v = document.querySelector('video');
    let track = null;
    try { track = v ? v.captureStream().getAudioTracks()[0] : null; } catch (e) { /* noop */ }
    if (!track || typeof window.MediaStreamTrackProcessor !== 'function') { syncPost({ error: true }); return; }
    const reader = new window.MediaStreamTrackProcessor({ track: track }).readable.getReader();
    let stopped = false;
    syncStop = function () {
      stopped = true;
      syncStop = null;
      try { reader.cancel(); } catch (e) { /* noop */ }
      try { track.stop(); } catch (e) { /* noop */ }
    };
    // 各サンプルの時刻は「音側の時刻 ts + anchor」で壁時計に直す。anchor は (届いた時刻 - ts) の
    // 最小値。届くのが遅れることはあっても早まることは無いので、最小値がいちばん正確。
    // 枠ごとの anchor が同じ基準になるので、親は枠をまたいで時刻を比べられる。
    let anchor = Infinity;
    let batch = [];
    let batchLen = 0;
    let batchTs = 0;
    (async function () {
      while (!stopped) {
        const r = await reader.read();
        if (r.done) break;
        const a = r.value;
        const ts = a.timestamp / 1000; // μs → ms
        anchor = Math.min(anchor, performance.timeOrigin + performance.now() - ts);
        const step = Math.max(1, Math.round(a.sampleRate / SYNC_RATE));
        const rate = a.sampleRate / step;
        const raw = new Float32Array(a.numberOfFrames);
        a.copyTo(raw, { planeIndex: 0, format: 'f32-planar' });
        a.close();
        const out = new Float32Array(Math.floor(raw.length / step));
        for (let i = 0; i < out.length; i++) {
          let s = 0;
          for (let j = 0; j < step; j++) s += raw[i * step + j];
          out[i] = s / step;
        }
        if (batchLen === 0) batchTs = ts;
        batch.push(out);
        batchLen += out.length;
        if (batchLen >= rate * SYNC_BATCH_SEC) {
          const pcm = new Float32Array(batchLen);
          let o = 0;
          for (const c of batch) { pcm.set(c, o); o += c.length; }
          syncPost({ ts: batchTs, anchor: anchor, rate: rate, pcm: pcm });
          batch = [];
          batchLen = 0;
        }
      }
    })().catch(function () { if (!stopped) syncPost({ error: true }); });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d[MAGIC] !== true || d.type !== 'sync-listen') return;
    if (d.value === true) syncStart();
    else if (syncStop) syncStop();
  });
})();
