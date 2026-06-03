// 配信サイトが iframe 内(= multiview のタイル)で読まれたときに動く content script。
// 役割:
//   1. 親(multiview.js)からの postMessage を受けて、フレーム内の <video> の muted/volume を制御。
//      クロスオリジンで親からは直接触れないので、フレーム内のこのスクリプトが代理で操作する。
//   2. Twitch のみ: シアターモードを1回 click して player を最大化。
// 最上位タブ(通常閲覧)では何もしない。

(function streamControl() {
  if (window.top === window.self) return; // iframe 内のみ動作
  const MAGIC = '__multiviewControl';
  const host = location.hostname;

  // ---- 音量制御 ----
  const desired = { muted: true, volume: 1 };
  let gotState = false;

  function clamp01(x) {
    x = Number(x);
    if (!isFinite(x)) return 1;
    return Math.max(0, Math.min(1, x));
  }

  function applyAudio() {
    const vids = document.querySelectorAll('video');
    for (const v of vids) {
      try {
        v.muted = desired.muted;
        if (!desired.muted) v.volume = clamp01(desired.volume);
      } catch (e) {
        /* noop */
      }
    }
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d[MAGIC] !== true) return;
    if (d.type === 'audio') {
      desired.muted = !!d.muted;
      desired.volume = clamp01(d.volume);
      gotState = true;
      applyAudio();
      // プレイヤー初期化で <video> が遅れて現れる場合に備えて数回追いがけ。
      [300, 1000, 2500].forEach((ms) => setTimeout(applyAudio, ms));
    }
  });

  // DOM 変化(新しい video の追加・差し替え)を拾って都度適用。多発するので軽くスロットル。
  let pending = false;
  const mo = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; applyAudio(); }, 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // 親へ「準備できた」を通知し、音声状態をもらう。受け取るまで数回リトライ。
  let announces = 0;
  function announce() {
    try { window.parent.postMessage({ [MAGIC]: true, type: 'ready' }, '*'); } catch (e) { /* noop */ }
  }
  announce();
  const annTimer = setInterval(() => {
    if (gotState || announces++ > 20) { clearInterval(annTimer); return; }
    announce();
  }, 400);

  // ---- Twitch のみ: シアターモードを1回 click ----
  if (host.includes('twitch.tv')) {
    const SELECTORS = [
      '[data-a-target="player-theatre-mode-button"]',
      'button[aria-label*="シアター"]',
      'button[aria-label*="Theatre" i]',
      'button[aria-label*="Theater" i]'
    ];
    let tries = 0;
    const tTimer = setInterval(() => {
      if (tries++ >= 20) { clearInterval(tTimer); return; }
      for (const sel of SELECTORS) {
        const el = document.querySelector(sel);
        if (el) { el.click(); clearInterval(tTimer); return; }
      }
    }, 500);
  }
})();
