// 配信サイトが iframe 内(= multiview のタイル)で読まれたときに動く content script。
// 役割:
//   1. 起動直後だけフレーム内の <video> を全ミュート(轟音防止)。以後は干渉せず、
//      ユーザーが各配信プレイヤー自前のミュート/音量で操作できるようにする。
//   2. 親(multiview)からの「全ミュート」指示で全 <video> をミュート(ツールバーのボタン用)。
//   3. Twitch のみ: シアターモードを1回 click して player を最大化。
// 最上位タブ(通常閲覧)では何もしない。

(function streamControl() {
  if (window.top === window.self) return; // iframe 内のみ動作
  const MAGIC = '__multiviewControl';
  const host = location.hostname;

  // ---- 音声: 起動直後だけ全ミュート ----
  function muteAll() {
    const vids = document.querySelectorAll('video');
    for (const v of vids) {
      try { v.muted = true; } catch (e) { /* noop */ }
    }
  }

  // 起動時にミュート。遅延ロードの <video> も拾うため数回だけ追いがけし、その後は止める。
  // 継続監視はしない(ユーザーがプレイヤー自前でミュート解除したのを巻き戻さないため)。
  muteAll();
  [300, 1200, 2500].forEach((ms) => setTimeout(muteAll, ms));

  // 親(multiview.html)からの「全ミュート」指示。
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return; // 親以外からの偽装を弾く
    const d = e.data;
    if (d && d[MAGIC] === true && d.type === 'mute-all') muteAll();
  });

  // ---- Twitch のみ: シアターモードを1回 click して player を最大化 ----
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
