// このスクリプトは chrome.scripting.executeScript で
// アクティブタブに content script として注入される。
// IIFE の戻り値（最後の式）が executeScript の result として返る。
//
// ねらい:
//   1. document.documentElement.requestFullscreen() の挙動を見る
//      （Android Chrome ではユーザージェスチャ起源でないと reject されることが多い）
//   2. 各配信サイトの「シアターモード」ボタンが取れるかを試す
//      → 取れるなら、Phase 2 ではボタンを叩くだけで「画面1枚最大化」までは行ける

(function fullscreenProbe() {
  const report = {
    location: location.href,
    hostname: location.hostname,
    documentFullscreenEnabled:
      typeof document.fullscreenEnabled === 'boolean'
        ? document.fullscreenEnabled
        : null,
    requestFullscreen: null,
    requestFullscreenError: null,
    fullscreenElementBefore: null,
    fullscreenElementAfter: null,
    theaterModeAttempts: []
  };

  try {
    report.fullscreenElementBefore = document.fullscreenElement
      ? document.fullscreenElement.tagName
      : null;
  } catch (e) {
    // noop
  }

  // requestFullscreen は Promise を返すが、ここで await すると IIFE の戻り値が
  // Promise になってしまい executeScript 側の結果がシリアライズで欠ける可能性がある。
  // そのため Promise を直接叩いて、結果はベストエフォートで同期記録する。
  try {
    const p = document.documentElement.requestFullscreen();
    if (p && typeof p.then === 'function') {
      report.requestFullscreen = 'pending';
      p.then(
        () => {
          report.requestFullscreen = 'success';
          try {
            report.fullscreenElementAfter = document.fullscreenElement
              ? document.fullscreenElement.tagName
              : null;
          } catch (e) {
            // noop
          }
        },
        (err) => {
          report.requestFullscreen = 'rejected';
          report.requestFullscreenError = {
            name: err && err.name,
            message: err && err.message
          };
        }
      );
    } else {
      report.requestFullscreen = 'called (no promise returned)';
    }
  } catch (e) {
    report.requestFullscreen = 'threw';
    report.requestFullscreenError = {
      name: e && e.name,
      message: e && e.message
    };
  }

  // TODO(human): 各サイトのシアターモードボタンセレクタは実機で検証して更新する。
  // 現状は推測値。サイトのDOMは頻繁に変わるため、Phase 2 開始時に再調査が必要。
  const THEATER_SELECTORS = [
    {
      hostMatch: 'twitch.tv',
      selectors: [
        '[data-a-target="player-theatre-mode-button"]', // TODO: 検証
        'button[aria-label*="シアター"]',
        'button[aria-label*="Theatre"]'
      ]
    },
    {
      hostMatch: 'youtube.com',
      selectors: [
        '.ytp-size-button', // TODO: 検証 (theater toggle = "t" key)
        'button.ytp-size-button'
      ]
    },
    {
      hostMatch: 'kick.com',
      selectors: [
        '[data-test-id="theatre-mode-button"]', // TODO: 検証
        'button[aria-label*="Theater"]'
      ]
    },
    {
      hostMatch: 'openrec.tv',
      selectors: [
        '[class*="theater"]', // TODO: 検証
        '[class*="Theater"]',
        '[aria-label*="シアター"]'
      ]
    }
  ];

  for (const site of THEATER_SELECTORS) {
    if (!location.hostname.includes(site.hostMatch)) continue;
    for (const selector of site.selectors) {
      const attempt = {
        host: site.hostMatch,
        selector,
        found: false,
        clicked: false,
        error: null
      };
      try {
        const el = document.querySelector(selector);
        if (el) {
          attempt.found = true;
          el.click();
          attempt.clicked = true;
        }
      } catch (e) {
        attempt.error = String(e);
      }
      report.theaterModeAttempts.push(attempt);
    }
  }

  return report;
})();
