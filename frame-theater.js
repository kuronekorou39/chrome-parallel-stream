// Twitch が iframe 内で読まれたとき(= multiview のタイル内)に、シアターモードを
// 1回だけ click して player を最大化する content script。
//
// manifest の content_scripts(matches: twitch.tv, all_frames: true)で全フレームに
// 注入されるが、最上位タブ(通常の Twitch 閲覧)では何もしないよう window.top で弾く。
// Twitch は既定でシアター OFF なので、ボタンを1回 click すれば ON になる(トグル誤爆なし)。

(function frameTheater() {
  // iframe 内でのみ動作させる(通常の全画面タブの閲覧には干渉しない)。
  if (window.top === window.self) return;
  if (!location.hostname.includes('twitch.tv')) return;

  const SELECTORS = [
    '[data-a-target="player-theatre-mode-button"]',
    'button[aria-label*="シアター"]',
    'button[aria-label*="Theatre" i]',
    'button[aria-label*="Theater" i]'
  ];
  const RETRY_INTERVAL_MS = 500;
  const MAX_RETRIES = 20; // 約10秒

  let tries = 0;
  const timer = setInterval(() => {
    if (tries++ >= MAX_RETRIES) {
      clearInterval(timer);
      return;
    }
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        clearInterval(timer);
        return;
      }
    }
  }, RETRY_INTERVAL_MS);
})();
