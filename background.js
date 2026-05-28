// Service Worker 本体。
// 各プローブを importScripts で取り込み、まとめて実行→storage に保存する。
//
// 注: importScripts の順序は意味がある。
//   api-surface.js が self.STANDARD_CHROME_EXTENSION_APIS を登録し、
//   webview-probe.js がそれを参照する。

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

  // 各プローブは独立。1つコケても他は走らせる。
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

// popup からのメッセージ
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'rerun-probes') {
    runAllProbes()
      .then((report) => sendResponse({ ok: true, report }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true; // async
  }

  if (msg.type === 'get-report') {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then((data) => sendResponse({ ok: true, report: data[STORAGE_KEY] || null }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true; // async
  }

  return false;
});

// 初回インストール時に1回走らせておく
chrome.runtime.onInstalled.addListener(() => {
  runAllProbes().catch((e) => console.error('[background] initial probe failed:', e));
});

// service worker が起動したタイミングでも軽くハートビート
chrome.runtime.onStartup &&
  chrome.runtime.onStartup.addListener(() => {
    console.log('[background] runtime onStartup fired');
  });
