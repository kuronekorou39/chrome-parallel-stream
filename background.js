// Service Worker 本体。
// Phase 1: ケイパビリティ・プローブ実行。
// マルチビュー本体は拡張機能ページ(multiview.html + multiview.js)側で完結するため、
// service worker はプローブ実行とレポート保存のみを担当する。

try {
  importScripts(
    'probes/api-surface.js',
    'probes/windows-probe.js',
    'probes/webview-probe.js'
  );
} catch (e) {
  console.error('[background] importScripts failed:', e);
}

const STORAGE_KEY = 'probeReport';

// ====== Phase 1: プローブ ======

async function runAllProbes() {
  const report = {
    timestamp: new Date().toISOString(),
    userAgent: safeNav('userAgent'),
    platform: safeNav('platform'),
    language: safeNav('language'),
    apiSurface: null,
    windowsProbe: null,
    webviewProbe: null,
    fullscreenProbe: null,
    errors: {}
  };

  await runStep(report, 'apiSurface', () =>
    typeof self.runApiSurfaceProbe === 'function'
      ? self.runApiSurfaceProbe()
      : Promise.reject(new Error('runApiSurfaceProbe is not loaded'))
  );
  await runStep(report, 'windowsProbe', () =>
    typeof self.runWindowsProbe === 'function'
      ? self.runWindowsProbe()
      : Promise.reject(new Error('runWindowsProbe is not loaded'))
  );
  await runStep(report, 'webviewProbe', () =>
    typeof self.runWebviewProbe === 'function'
      ? self.runWebviewProbe()
      : Promise.reject(new Error('runWebviewProbe is not loaded'))
  );
  await runStep(report, 'fullscreenProbe', () => runFullscreenProbeInActiveTab());

  await chrome.storage.local.set({ [STORAGE_KEY]: report });
  return report;
}

async function runStep(report, key, thunk) {
  try {
    report[key] = await thunk();
  } catch (e) {
    report.errors[key] = errorToObject(e);
  }
}

async function runFullscreenProbeInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) {
    return { skipped: true, reason: 'no active tab' };
  }
  const url = tab.url || '';
  if (/^(chrome|chrome-extension|about|edge|brave|opera):/i.test(url)) {
    return { skipped: true, reason: 'cannot inject into restricted URL', url };
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['probes/fullscreen-probe.js']
  });
  return {
    targetTab: { id: tab.id, url, title: tab.title },
    frameResults: results.map((r) => ({
      frameId: r.frameId,
      documentId: r.documentId,
      result: r.result,
      error: r.error || null
    }))
  };
}

// ====== 共通ヘルパ ======

function errorToObject(e) {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { value: String(e) };
}

function safeNav(key) {
  try {
    return typeof navigator !== 'undefined' ? navigator[key] : null;
  } catch (e) {
    return null;
  }
}

// ====== メッセージハンドラ ======

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'rerun-probes') {
    runAllProbes()
      .then((report) => sendResponse({ ok: true, report }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true;
  }

  if (msg.type === 'get-report') {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then((data) => sendResponse({ ok: true, report: data[STORAGE_KEY] || null }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true;
  }

  if (msg.type === 'get-kick-playback') {
    fetchKickPlayback(msg.channel)
      .then((playbackUrl) => sendResponse({ ok: true, playbackUrl }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true;
  }

  return false;
});

// Kick のチャンネルから HLS 再生URL(Amazon IVS の m3u8)を取得する。
// kick.com/api/v2 は Cloudflare 配下。service worker からの fetch は本物の Chrome の
// ネットワークスタックを使い、credentials:'include' でユーザーの kick.com クッキー
// (cf_clearance 等)を同送するため、拡張ページ(null origin 扱い)より突破しやすい。
async function fetchKickPlayback(channel) {
  if (!channel) throw new Error('no channel');
  const res = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(channel), {
    credentials: 'include',
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('Kick API HTTP ' + res.status);
  const data = await res.json();
  const url =
    data.playback_url ||
    (data.livestream && data.livestream.playback_url) ||
    null;
  if (!url) throw new Error('playback_url なし(オフライン配信の可能性)');
  return url;
}

// ====== ライフサイクル ======

chrome.runtime.onInstalled.addListener(() => {
  runAllProbes().catch((e) => console.error('[background] initial probe failed:', e));
});

chrome.runtime.onStartup &&
  chrome.runtime.onStartup.addListener(() => {
    console.log('[background] runtime onStartup fired');
  });
