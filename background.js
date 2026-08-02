// Service Worker 本体。
// マルチビューの UI は通常の https オリジン(GitHub Pages)に置いたページが担当し、
// service worker は拡張の権限が要る処理だけを受け持つ:
//   - 埋め込みフレームでログインを使うための Cookie 緩和
//   - Kick の HLS 再生URL取得(CORS のためページからは直接叩けない)
//   - page-bridge.js からの中継(content script では使えない chrome.system / chrome.tabs)

// ====== 共通ヘルパ ======

function errorToObject(e) {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { value: String(e) };
}


// ====== メッセージハンドラ ======

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  // 自分の拡張の文脈(popup / multiview ページ / 自分が注入した content script)からのみ受け付ける。
  // UI ページを通常の https オリジンへ置けるようにしたことで、page-bridge.js 経由の依頼が入り口として
  // 増えたため、送信元の確認を必須にする。
  if (sender.id !== chrome.runtime.id) return false;



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

