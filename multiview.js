// 拡張機能のページ内に複数配信をタイル表示する。
// popup の「Open Multiview」が storage(MULTIVIEW_ACTIVE_KEY)に URL 群を書いてから
// このページ(multiview.html)をタブで開く。ここはそれを読んで iframe グリッドを作るだけ。
//
// 配信サイトは X-Frame-Options / CSP(frame-ancestors)で iframe 埋め込みを拒否するので、
// rules.json の declarativeNetRequest ルールが sub_frame 読込時にそれらのヘッダを剥がす。

const MULTIVIEW_ACTIVE_KEY = 'multiviewActive';
const MAX_CELLS = 4;

const IFRAME_ALLOW = 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write';

(async function initMultiview() {
  const grid = document.getElementById('grid');
  const data = await chrome.storage.local.get(MULTIVIEW_ACTIVE_KEY);
  const active = data[MULTIVIEW_ACTIVE_KEY] || {};
  const urls = (active.urls || []).map((u) => (u || '').trim()).filter((u) => u.length > 0);

  if (urls.length === 0) {
    grid.innerHTML =
      '<div class="empty">表示する配信がありません。拡張機能のポップアップから URL を入れて Open Multiview してください。</div>';
    return;
  }

  const count = Math.min(urls.length, MAX_CELLS);
  // 1 → 1x1 / 2 → 2x1 / 3,4 → 2x2
  grid.style.gridTemplateColumns = count <= 1 ? '1fr' : '1fr 1fr';
  grid.style.gridTemplateRows = count <= 2 ? '1fr' : '1fr 1fr';

  for (let i = 0; i < count; i++) {
    grid.appendChild(makeCell(urls[i]));
  }
  document.title = 'Multiview (' + count + ')';
})();

function makeCell(url) {
  const cell = document.createElement('div');
  cell.className = 'cell';

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = labelFor(url);
  cell.appendChild(badge);

  const frame = document.createElement('iframe');
  frame.src = url;
  frame.allow = IFRAME_ALLOW;
  frame.setAttribute('allowfullscreen', '');
  frame.referrerPolicy = 'no-referrer';
  cell.appendChild(frame);

  return cell;
}

// バッジ表示用に host/チャンネルだけ抜き出す(失敗時は素の URL)。
function labelFor(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname;
  } catch (e) {
    return url;
  }
}
