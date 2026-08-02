// Service Worker 本体。
// Phase 1: ケイパビリティ・プローブ実行。
// マルチビュー本体は拡張機能ページ(multiview.html + multiview.js)側で完結するため、
// service worker はプローブ実行とレポート保存のみを担当する。

try {
  importScripts(
    'api-surface.js',
    'windows-probe.js',
    'webview-probe.js'
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
    files: ['fullscreen-probe.js']
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  // 自分の拡張の文脈(popup / multiview ページ / 自分が注入した content script)からのみ受け付ける。
  // UI ページを通常の https オリジンへ置けるようにしたことで、page-bridge.js 経由の依頼が入り口として
  // 増えたため、送信元の確認を必須にする。
  if (sender.id !== chrome.runtime.id) return false;

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

  if (msg.type === 'relax-cookies') {
    // 対象は埋め込みでログインを使うサイトだけに固定する。任意ドメインを受けると
    // 「どんなサイトの Cookie 保護でも恒久的に外せる」プリミティブになってしまうため。
    const domains = (msg.domains || []).filter((d) => RELAXABLE_DOMAINS.includes(d));
    Promise.all(domains.map((d) => relaxCookies(d)))
      .then((counts) => sendResponse({ ok: true, counts }))
      .catch((e) => sendResponse({ ok: false, error: errorToObject(e) }));
    return true;
  }

  // ---- UI ページを通常オリジンに置いたときの中継(page-bridge.js から来る) ----
  // content script からは chrome.system.* / chrome.tabs.* を呼べないため、ここで代行する。
  if (msg.type === 'bridge-system-cpu') {
    chrome.system.cpu.getInfo().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === 'bridge-system-memory') {
    chrome.system.memory.getInfo().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === 'bridge-open-tab') {
    // 開けるのは http(s) のみ(javascript: 等を弾く)。
    const url = typeof msg.url === 'string' ? msg.url : '';
    if (/^https?:\/\//i.test(url)) chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// Cookie の SameSite を緩められるドメイン(埋め込み内でログインを使うサイトのみ)。
const RELAXABLE_DOMAINS = ['twitch.tv', 'openrec.tv', 'kick.com'];

// 対象ドメインの Cookie を SameSite=None; Secure に再設定する。
// 既定(Lax)だと別サイト扱いの埋め込みフレームへログインCookieが送られず未ログインになる。
// None にすると埋め込み内でも送られ、フレーム内でログイン状態になり投稿等ができる。
// ※ ユーザーの Cookie を改変する操作(ユーザー同意のうえで実行)。サイトが Cookie を
//   再設定すると元に戻りうるため、各ウィンドウ生成時に都度呼ぶ。
async function relaxCookies(domain) {
  let cookies;
  try {
    cookies = await chrome.cookies.getAll({ domain });
  } catch (e) {
    return 0;
  }
  let changed = 0;
  for (const c of cookies) {
    if (c.sameSite === 'no_restriction' && c.secure) continue; // 既に緩い
    const host = c.domain.replace(/^\./, '');
    const details = {
      url: 'https://' + host + c.path,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: true, // SameSite=None には Secure が必須
      httpOnly: c.httpOnly,
      sameSite: 'no_restriction',
      storeId: c.storeId
    };
    if (!c.hostOnly) details.domain = c.domain; // host-only cookie は domain を付けない
    if (!c.session && typeof c.expirationDate === 'number') {
      details.expirationDate = c.expirationDate;
    }
    try {
      await chrome.cookies.set(details);
      changed++;
    } catch (e) {
      // 一部 cookie は再設定不可。無視して継続。
    }
  }
  return changed;
}

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

// Phase 1 のケイパビリティ調査(runAllProbes)は windows-probe が chrome.windows.create / remove で
// テスト用ウィンドウを複数開閉する。これを拡張ロード時(onInstalled)に自動実行していたため、読み込みの
// たびに「謎の空ウィンドウが複数開いて閉じる」挙動になっていた。マルチビュー本体には不要なので自動実行は
// やめる。調査が必要なときは popup の Probe タブ(rerun-probes メッセージ)から手動で実行する。
