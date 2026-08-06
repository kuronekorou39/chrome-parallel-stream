// popup の描画とアクション。マルチビューへの入口と、保存中の配信のプレビューだけを持つ。

// 専用ページ(multiview.html)が保持する「保存中の配信」セット。専用ページ側が更新する。
const MULTIVIEW_ACTIVE_KEY = 'multiviewActive';

// UI ページは通常の https オリジン(GitHub Pages)に置いている。
// 拡張ページ(chrome-extension://)の中の iframe には他の拡張の content script が一切注入されず、
// 広告スキッパー等が枠に効かないため。拡張ページとして開かれた場合はこの URL へ転送する
// (転送は ext-bridge.js が行う)。
const MULTIVIEW_URL = 'https://kuronekorou39.github.io/chrome-parallel-stream/multiview.html';

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

// 専用ページのタブを開く。既に開いていればそれをフォーカスする(重複タブを作らない)。
async function openMultiview() {
  $('open-multiview').disabled = true;
  try {
    const all = await chrome.tabs.query({});
    const existing = all.find((t) => t.url && t.url.startsWith(MULTIVIEW_URL));
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      setStatus('既存のマルチビュータブをフォーカスしました。', 'success');
    } else {
      await chrome.tabs.create({ url: MULTIVIEW_URL });
      setStatus('マルチビューを開きました。', 'success');
    }
  } catch (e) {
    setStatus('Open error: ' + e.message, 'error');
  } finally {
    $('open-multiview').disabled = false;
  }
}

// ---- 保存中の配信(専用ページで追加した分のプレビュー) ----

async function renderSavedList() {
  const data = await chrome.storage.local.get(MULTIVIEW_ACTIVE_KEY);
  const saved = data[MULTIVIEW_ACTIVE_KEY] || {};
  // 新フォーマット(wins: 位置付き)からも、旧フォーマット(urls)からも URL を取り出す。
  const urls = Array.isArray(saved.wins)
    ? saved.wins.map((w) => w && w.url).filter(Boolean)
    : (saved.urls || []);
  if (!urls.length) {
    $('saved-list').innerHTML = '<span class="empty">なし</span>';
    return;
  }
  $('saved-list').innerHTML = urls
    .map((u) => '<div class="member">• ' + escapeHtml(u) + '</div>')
    .join('');
}

// 消すのは「保存中の配信」だけ。この保存には配信の一覧のほかに、全体音量・弾幕の設定・
// 弾幕/チャットの既定も同居している。丸ごと上書きすると、配信を消したつもりで設定まで
// 消える(実際にそうなっていた)。読み出してから配信の分だけを空にして書き戻す。
// 専用ページのキー名を知らなくて済むよう、残す側ではなく消す側を列挙する。
const CLEARED_KEYS = ['wins', 'urls'];
async function clearSaved() {
  const data = await chrome.storage.local.get(MULTIVIEW_ACTIVE_KEY);
  const saved = data[MULTIVIEW_ACTIVE_KEY] || {};
  const next = Object.assign({}, saved, { timestamp: new Date().toISOString() });
  CLEARED_KEYS.forEach((k) => { if (k in next) next[k] = []; });
  await chrome.storage.local.set({ [MULTIVIEW_ACTIVE_KEY]: next });
  await renderSavedList();
  setStatus('保存中の配信をクリアしました(音量・弾幕などの設定は残ります)。', 'success');
}

document.addEventListener('DOMContentLoaded', async () => {
  $('open-multiview').addEventListener('click', openMultiview);
  $('clear-saved').addEventListener('click', clearSaved);
  await renderSavedList();
});
