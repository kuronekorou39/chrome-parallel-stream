// Service Worker 本体。
// Phase 1: ケイパビリティ・プローブ実行
// Phase 2: マルチビュー (popup から指定された URL 群を独立 popup ウィンドウで開き、
//          各タブで multiview/auto-activate.js を inject してシアターモード自動 ON)

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
const OPENED_WINDOWS_KEY = 'openedMultiviewWindows';
const MULTIVIEW_LAST_KEY = 'multiviewLastRun';

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

// ====== Phase 2: マルチビュー ======

async function openMultiview(urls, layouts) {
  const windowIds = [];
  const injectResults = [];

  for (let i = 0; i < urls.length; i++) {
    const rect = layouts[i] || {};
    const created = await chrome.windows.create({
      url: urls[i],
      type: 'popup',
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      focused: i === 0
    });
    windowIds.push(created.id);
    if (created.tabs && created.tabs[0]) {
      scheduleAutoActivate(created.tabs[0].id, urls[i], injectResults);
    }
  }

  await chrome.storage.local.set({ [OPENED_WINDOWS_KEY]: windowIds });
  await chrome.storage.local.set({
    [MULTIVIEW_LAST_KEY]: {
      timestamp: new Date().toISOString(),
      urls,
      windowIds,
      injectResults
    }
  });
  return windowIds;
}

// タブの load 完了を待って auto-activate.js を inject する。
// 同じ tabId に対するハンドラは1回だけ発火し、その後解除する。
function scheduleAutoActivate(tabId, url, accumulator) {
  const listener = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);

    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['multiview/auto-activate.js']
      })
      .then((results) => {
        accumulator.push({
          tabId,
          url,
          result: results && results[0] ? results[0].result : null
        });
      })
      .catch((e) => {
        console.error('[multiview] inject failed for tab', tabId, e);
        accumulator.push({ tabId, url, error: errorToObject(e) });
      });
  };
  chrome.tabs.onUpdated.addListener(listener);
}

async function closeMultiview() {
  const data = await chrome.storage.local.get(OPENED_WINDOWS_KEY);
  const ids = data[OPENED_WINDOWS_KEY] || [];
  const closed = [];
  for (const id of ids) {
    try {
      await chrome.windows.remove(id);
      closed.push(id);
    } catch (e) {
      // すでに閉じられている等、無視
    }
  }
  await chrome.storage.local.set({ [OPENED_WINDOWS_KEY]: [] });
  return closed;
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

  if (msg.type === 'open-multiview') {
    openMultiview(msg.urls || [], msg.layouts || [])
      .then((windowIds) => sendResponse({ ok: true, windowIds }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true;
  }

  if (msg.type === 'close-multiview') {
    closeMultiview()
      .then((closed) => sendResponse({ ok: true, closed }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true;
  }

  return false;
});

// ====== ライフサイクル ======

chrome.runtime.onInstalled.addListener(() => {
  runAllProbes().catch((e) => console.error('[background] initial probe failed:', e));
});

chrome.runtime.onStartup &&
  chrome.runtime.onStartup.addListener(() => {
    console.log('[background] runtime onStartup fired');
  });
