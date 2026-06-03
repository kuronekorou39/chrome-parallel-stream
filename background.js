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
const PENDING_INJECT_KEY = 'pendingMultiviewInject';

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

// popup から渡された URL 群を独立 popup ウィンドウでタイル配置して開く。
// 各ウィンドウの load 完了はトップレベル登録の onUpdated リスナ(本ファイル下部)が
// pending マップ経由で検知し、auto-activate.js を inject する。
// 1窓ずつ try/catch で保護し、失敗 URL は failures に記録して残りを継続する。
async function openMultiview(urls, layouts, layoutMode) {
  const windowIds = [];
  const failures = [];

  // 新しい run を始める前に、前回の取りこぼし pending を掃除する。
  await chrome.storage.local.set({ [PENDING_INJECT_KEY]: {} });

  for (let i = 0; i < urls.length; i++) {
    const rect = layouts[i] || {};
    try {
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
      // 途中で失敗しても close-multiview で回収できるよう、生成のたびに保存する。
      await chrome.storage.local.set({ [OPENED_WINDOWS_KEY]: windowIds });
      const tabId = created.tabs && created.tabs[0] ? created.tabs[0].id : null;
      if (tabId != null) await addPendingInject(tabId, urls[i]);
    } catch (e) {
      failures.push({ url: urls[i], error: errorToObject(e) });
    }
  }

  await chrome.storage.local.set({
    [MULTIVIEW_LAST_KEY]: {
      timestamp: new Date().toISOString(),
      layout: layoutMode || null,
      urls,
      windowIds,
      failures,
      // inject 結果はタブ load 完了後に recordInjectResult が追記していく。
      injectResults: []
    }
  });
  return { windowIds, failures };
}

// inject 対象タブを storage に登録する。トップレベルのリスナがこれを参照するため、
// SW が一度落ちても(再起動後に)復元できる。
async function addPendingInject(tabId, url) {
  const data = await chrome.storage.local.get(PENDING_INJECT_KEY);
  const pending = data[PENDING_INJECT_KEY] || {};
  pending[tabId] = url;
  await chrome.storage.local.set({ [PENDING_INJECT_KEY]: pending });
}

// タブの load 完了時に呼ばれる。pending に居るタブだけ auto-activate.js を inject し、
// 結果を MULTIVIEW_LAST_KEY.injectResults に追記する。
async function handleTabComplete(tabId) {
  const data = await chrome.storage.local.get(PENDING_INJECT_KEY);
  const pending = data[PENDING_INJECT_KEY] || {};
  if (!Object.prototype.hasOwnProperty.call(pending, tabId)) return;

  const url = pending[tabId];
  // 同一タブの 'complete' が複数回来ても二重 inject しないよう、先に pending から外す。
  delete pending[tabId];
  await chrome.storage.local.set({ [PENDING_INJECT_KEY]: pending });

  let result = null;
  let error = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['multiview/auto-activate.js']
    });
    result = results && results[0] ? results[0].result : null;
  } catch (e) {
    console.error('[multiview] inject failed for tab', tabId, e);
    error = errorToObject(e);
  }
  await recordInjectResult({ tabId, url, result, error });
}

// inject 結果を最新 run に追記する(read-modify-write)。
// 旧実装は openMultiview 完了時に空配列で固定保存していたため結果が観測できなかった。
async function recordInjectResult(entry) {
  const data = await chrome.storage.local.get(MULTIVIEW_LAST_KEY);
  const last = data[MULTIVIEW_LAST_KEY];
  if (!last) return;
  last.injectResults = last.injectResults || [];
  last.injectResults.push(entry);
  await chrome.storage.local.set({ [MULTIVIEW_LAST_KEY]: last });
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
  await chrome.storage.local.set({ [OPENED_WINDOWS_KEY]: [], [PENDING_INJECT_KEY]: {} });
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
    openMultiview(msg.urls || [], msg.layouts || [], msg.layout)
      .then(({ windowIds, failures }) => sendResponse({ ok: true, windowIds, failures }))
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

// ====== マルチビュー inject トリガ ======

// トップレベルで登録するため SW 再起動後も復元される(動的登録だと SW 終了で消える)。
// pending マップ(storage 永続)に居るタブの load 完了だけを拾って inject する。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  handleTabComplete(tabId).catch((e) =>
    console.error('[multiview] handleTabComplete failed for tab', tabId, e)
  );
});

// ====== ライフサイクル ======

chrome.runtime.onInstalled.addListener(() => {
  runAllProbes().catch((e) => console.error('[background] initial probe failed:', e));
});

chrome.runtime.onStartup &&
  chrome.runtime.onStartup.addListener(() => {
    console.log('[background] runtime onStartup fired');
  });
