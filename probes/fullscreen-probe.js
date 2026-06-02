// このスクリプトは chrome.scripting.executeScript で
// アクティブタブに content script として注入される。
// async IIFE の戻り値 Promise は executeScript が resolve するまで待ってくれる
// （Chrome docs: "If the result is a Promise, ... it is resolved before returning."）
//
// ねらい:
//   1. document.documentElement.requestFullscreen() の挙動を見る
//      （Android Chrome ではユーザージェスチャ起源でないと reject されることが多い）
//   2. 各配信サイトでシアターモード切替を 3 戦略で試す:
//        a. DOM ボタン click（主戦略 / 現状 3/4 サイトで成立）
//        b. data 属性の直接書換（Kick の data-theatre 等、サイト固有のフォールバック）
//        c. キーボードショートカット dispatch（汎用フォールバック、video 要素ターゲット）
//      → 最初に成功した戦略で stop（UI を複数回トグルさせない）

(async function fullscreenProbe() {
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

  // requestFullscreen の Promise を await して結果を確定させる。
  // 確定状態: 'success' | 'rejected' | 'threw' | 'called (no promise returned)'
  try {
    const p = document.documentElement.requestFullscreen();
    if (p && typeof p.then === 'function') {
      try {
        await p;
        report.requestFullscreen = 'success';
      } catch (err) {
        report.requestFullscreen = 'rejected';
        report.requestFullscreenError = {
          name: err && err.name,
          message: err && err.message,
          string: String(err)
        };
      }
    } else {
      report.requestFullscreen = 'called (no promise returned)';
    }

    try {
      report.fullscreenElementAfter = document.fullscreenElement
        ? document.fullscreenElement.tagName
        : null;
    } catch (e) {
      // noop
    }
  } catch (e) {
    report.requestFullscreen = 'threw';
    report.requestFullscreenError = {
      name: e && e.name,
      message: e && e.message,
      string: String(e)
    };
  }

  // TODO(human): セレクタは実機で再検証。サイトのDOMは頻繁に変わる。
  // 構成: selectors(click) → attributeToggle(サイト固有) → keyboardShortcut(汎用)
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
      // Kick はサンプルHTMLにシアターモードボタンが見当たらず、
      // ホバー時に動的描画される可能性が高い。属性書換 / キー送信のフォールバックに期待。
      selectors: [
        '[data-test-id="theatre-mode-button"]',
        'button[aria-label*="Theatre" i]',
        'button[aria-label*="Theater" i]'
      ],
      attributeToggle: { selector: '[data-theatre]', attr: 'data-theatre' },
      keyboardShortcut: { key: 't', targetSelector: 'video' }
    },
    {
      hostMatch: 'openrec.tv',
      // OPENREC は OFF/ON で別ボタンが切替表示される。<button>ではなく<div role="button">。
      // 現在表示中のボタンを :not(.is-display-none) で取り、フォールバックも置く。
      // 旧 `[class*="theater"]` は theater-input-area(チャット欄)などに誤マッチして
      // 動画停止を起こしていたため完全削除。
      selectors: [
        '.theater-mode-enter-icon:not(.is-display-none)',
        '.theater-mode-exit-icon:not(.is-display-none)',
        '.theater-mode-enter-icon',
        '.theater-mode-exit-icon'
      ],
      attributeToggle: null,
      keyboardShortcut: { key: 't', targetSelector: 'video' }
    }
  ];

  for (const site of STRATEGIES) {
    if (!location.hostname.includes(site.hostMatch)) continue;
    const siteResult = {
      host: site.hostMatch,
      attempts: [],
      succeeded: false,
      succeededVia: null
    };

    // 戦略 1: DOM ボタン click
    for (const selector of site.selectors) {
      const a = { type: 'click', selector, found: false, ok: false, error: null };
      try {
        const el = document.querySelector(selector);
        if (el) {
          a.found = true;
          el.click();
          a.ok = true;
          siteResult.succeeded = true;
          siteResult.succeededVia = 'click:' + selector;
        }
      } catch (e) {
        a.error = String(e);
      }
      siteResult.attempts.push(a);
      if (siteResult.succeeded) break;
    }

    // 戦略 2: 属性書換（前段失敗時のみ、サイト固有）
    if (!siteResult.succeeded && site.attributeToggle) {
      const a = {
        type: 'attribute-toggle',
        selector: site.attributeToggle.selector,
        attr: site.attributeToggle.attr,
        found: false,
        oldValue: null,
        newValue: null,
        ok: false,
        error: null
      };
      try {
        const el = document.querySelector(site.attributeToggle.selector);
        if (el) {
          a.found = true;
          const old = el.getAttribute(site.attributeToggle.attr);
          a.oldValue = old;
          const next = old === 'true' ? 'false' : 'true';
          el.setAttribute(site.attributeToggle.attr, next);
          a.newValue = next;
          a.ok = true;
          siteResult.succeeded = true;
          siteResult.succeededVia =
            'attribute-toggle:' +
            site.attributeToggle.selector +
            '[' +
            site.attributeToggle.attr +
            ']';
        }
      } catch (e) {
        a.error = String(e);
      }
      siteResult.attempts.push(a);
    }

    // 戦略 3: キーボードショートカット dispatch（前段失敗時のみ、汎用）
    if (!siteResult.succeeded && site.keyboardShortcut) {
      const a = {
        type: 'keyboard',
        key: site.keyboardShortcut.key,
        targetSelector: site.keyboardShortcut.targetSelector,
        targetFound: false,
        targetTag: null,
        dispatched: false,
        ok: false,
        error: null
      };
      try {
        const target = document.querySelector(site.keyboardShortcut.targetSelector);
        if (target) {
          a.targetFound = true;
          a.targetTag = target.tagName;
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
          a.dispatched = true;
          a.ok = true;
          siteResult.succeeded = true;
          siteResult.succeededVia = 'keyboard:' + site.keyboardShortcut.key;
        }
      } catch (e) {
        a.error = String(e);
      }
      siteResult.attempts.push(a);
    }

    report.theaterModeAttempts.push(siteResult);
  }

  return report;
})();
