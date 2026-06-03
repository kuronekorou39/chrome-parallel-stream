// 各 multiview ウィンドウのページに inject される content script。
// 目的: 該当配信サイトのシアターモードを ON にする (1回成功したら止まる)。
//
// Phase 1 の fullscreen-probe.js で確定した 4サイトの戦略を引き継ぐが、
// requestFullscreen は呼ばない / トグル動作の事故を避けるため OFF→ON 方向のみ狙う。
//
// 描画完了直後はプレイヤーコントロールが DOM に未挿入なことがあるので、
// 500ms × 最大20回 (= 10秒) リトライする。

(async function multiviewAutoActivate() {
  const RETRY_INTERVAL_MS = 500;
  const MAX_RETRIES = 20;

  // 各サイトの戦略。click → attribute-toggle → keyboard の順で試す。
  // OPENREC は enter-icon (OFF→ON 入口) のみに絞って、誤って exit-icon を
  // クリックして OFF に倒さないようにする。Kick は属性書換の固定値で OFF→ON。
  const STRATEGIES = [
    {
      hostMatch: 'twitch.tv',
      selectors: [
        '[data-a-target="player-theatre-mode-button"]',
        'button[aria-label*="シアター"]',
        'button[aria-label*="Theatre" i]',
        'button[aria-label*="Theater" i]'
      ],
      attributeToggle: null,
      keyboardShortcut: { key: 't', targetSelector: 'video' }
    },
    {
      hostMatch: 'youtube.com',
      selectors: ['.ytp-size-button', 'button.ytp-size-button'],
      attributeToggle: null,
      keyboardShortcut: { key: 't', targetSelector: 'video' }
    },
    {
      hostMatch: 'kick.com',
      selectors: [
        '[data-test-id="theatre-mode-button"]',
        'button[aria-label*="Theatre" i]',
        'button[aria-label*="Theater" i]'
      ],
      attributeToggle: { selector: '[data-theatre]', attr: 'data-theatre', value: 'true' },
      keyboardShortcut: { key: 't', targetSelector: 'video' }
    },
    {
      hostMatch: 'openrec.tv',
      selectors: ['.theater-mode-enter-icon:not(.is-display-none)'],
      attributeToggle: null,
      keyboardShortcut: { key: 't', targetSelector: 'video' }
    }
  ];

  const site = STRATEGIES.find((s) => location.hostname.includes(s.hostMatch));
  if (!site) {
    return { skipped: true, reason: 'no strategy for hostname', hostname: location.hostname };
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    const r = tryOnce(site);
    if (r.succeeded) {
      return {
        succeeded: true,
        attempt: i + 1,
        succeededVia: r.succeededVia,
        hostname: location.hostname
      };
    }
    await sleep(RETRY_INTERVAL_MS);
  }
  return {
    succeeded: false,
    attempts: MAX_RETRIES,
    reason: 'all retries exhausted',
    hostname: location.hostname
  };

  function tryOnce(site) {
    // 1. click
    for (const selector of site.selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          return { succeeded: true, succeededVia: 'click:' + selector };
        }
      } catch (e) {
        // try next
      }
    }
    // 2. attribute-toggle (Kick の data-theatre 等、サイト固有)
    if (site.attributeToggle) {
      try {
        const at = site.attributeToggle;
        const el = document.querySelector(at.selector);
        if (el) {
          const target = at.value || 'true';
          el.setAttribute(at.attr, target);
          return { succeeded: true, succeededVia: 'attribute-toggle:' + at.attr + '=' + target };
        }
      } catch (e) {
        // try next
      }
    }
    // 3. keyboard (汎用フォールバック)
    if (site.keyboardShortcut) {
      try {
        const target = document.querySelector(site.keyboardShortcut.targetSelector);
        if (target) {
          const opts = {
            key: site.keyboardShortcut.key,
            code: 'Key' + site.keyboardShortcut.key.toUpperCase(),
            bubbles: true,
            cancelable: true
          };
          if (typeof target.focus === 'function') {
            try { target.focus(); } catch (e) { /* noop */ }
          }
          target.dispatchEvent(new KeyboardEvent('keydown', opts));
          target.dispatchEvent(new KeyboardEvent('keypress', opts));
          target.dispatchEvent(new KeyboardEvent('keyup', opts));
          return { succeeded: true, succeededVia: 'keyboard:' + site.keyboardShortcut.key };
        }
      } catch (e) {
        // noop
      }
    }
    return { succeeded: false };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
