// multiview の UI ページから拡張機能の機能を使うための薄い橋渡し。multiview.js より先に読むこと。
//
// このページは2通りの置かれ方をする:
//   1. 拡張ページ (chrome-extension://.../multiview.html) … chrome.* がそのまま使える
//   2. 通常の https ページ (GitHub Pages 等)          … chrome.* は使えない
//
// 2 が必要な理由: 拡張ページの中に置いた iframe には、他の拡張(広告スキッパー等)の content script が
// 一切注入されない(Chrome の仕様。executeScript も "Cannot access contents of the page" で弾かれる)。
// 通常ページの iframe なら普通に注入されるため、枠に他拡張の機能を効かせるにはこちらに置く必要がある。
//
// 2 のときは、拡張が同オリジンへ注入する page-bridge.js へ postMessage で依頼し、結果を受け取る。
// どちらの場合も呼び出し側は MV.* を chrome.* と同じ形で使えるので、multiview.js 側の差分は最小で済む。
(function extBridge() {
  'use strict';

  const DIRECT = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
  const REQ = 'mvBridgeReq';
  const RES = 'mvBridgeRes';
  const TIMEOUT_MS = 5000;

  // ---- 通常ページ用: page-bridge.js への依頼 ----
  let seq = 0;
  const pending = new Map();

  if (!DIRECT) {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return; // 同一ウィンドウ(=注入された content script)からのみ
      const d = e.data;
      if (!d || d.__mv !== RES) return;
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || 'bridge error'));
    });
  }

  function call(op, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        // 拡張が入っていない/まだ注入されていない場合はここに来る。
        reject(new Error('拡張機能から応答がありません(未インストールの可能性)'));
      }, timeoutMs || TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ __mv: REQ, id, op, payload }, location.origin);
    });
  }

  // ---- 拡張機能が入っていないときの案内 ----
  // このページは UI だけで、枠の埋め込み(CSP/X-Frame-Options の除去)も枠内の音量・弾幕も
  // 拡張機能側が担っている。拡張が無いと枠が真っ白なまま理由も分からないので、明示する。
  // 手順そのものを画面に出す。リンク先へ飛ばすだけだと、着地先で何をすればいいか分からない。
  // chrome://extensions はウェブページからリンクにしても Chrome が遷移を拒否するため、
  // クリックさせず「コピーして貼る」形で見せる。
  const REPO_URL = 'https://github.com/kuronekorou39/chrome-parallel-stream';
  const ZIP_URL = REPO_URL + '/archive/refs/heads/main.zip';

  function showMissingExtensionNotice() {
    if (document.getElementById('mv-no-ext')) return;

    const el = document.createElement('div');
    el.id = 'mv-no-ext';
    el.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
      'background:#1b0d0f', 'color:#ffdcd9', 'border-bottom:1px solid #f85149',
      'font:13px/1.7 system-ui,sans-serif', 'padding:14px 18px',
      'max-height:70vh', 'overflow:auto', 'box-shadow:0 4px 18px rgba(0,0,0,0.6)'
    ].join(';');

    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:760px;margin:0 auto';

    const h = document.createElement('div');
    h.textContent = '⚠ 拡張機能「Parallel Stream」が必要です';
    h.style.cssText = 'font-size:15px;font-weight:bold;color:#ff9c94;margin-bottom:6px';

    const lead = document.createElement('div');
    lead.textContent =
      'このページは操作画面だけです。配信サイトの埋め込み、枠ごとの音量、弾幕は拡張機能が行うため、' +
      '入れていないと枠が1つも表示されず、設定も保存されません。';
    lead.style.cssText = 'margin-bottom:10px';

    const code = (t) => {
      const c = document.createElement('code');
      c.textContent = t;
      c.style.cssText =
        'background:#000;color:#ffd9d5;padding:1px 6px;border-radius:4px;' +
        'font-family:ui-monospace,Consolas,monospace;user-select:all';
      return c;
    };

    const ol = document.createElement('ol');
    ol.style.cssText = 'margin:0 0 10px;padding-left:1.4em';
    const li = (...nodes) => {
      const l = document.createElement('li');
      l.append(...nodes);
      l.style.marginBottom = '3px';
      ol.appendChild(l);
    };

    const zip = document.createElement('a');
    zip.href = ZIP_URL;
    zip.textContent = 'ZIP をダウンロード';
    zip.style.cssText = 'color:#ff9c94;font-weight:bold';
    li('リポジトリを取得して展開する(', zip, ' / または git clone)');
    li('Chrome のアドレスバーに ', code('chrome://extensions'), ' を貼って開き、「デベロッパーモード」を ON');
    li('「パッケージ化されていない拡張機能を読み込む」を押し、展開したフォルダ(', code('manifest.json'), ' がある場所)を選ぶ');
    li('このページを再読み込みする');

    const more = document.createElement('a');
    more.href = REPO_URL + '#インストール';
    more.target = '_blank';
    more.rel = 'noopener';
    more.textContent = '詳しい説明とこの拡張がブラウザに与える影響';
    more.style.color = '#ff9c94';

    const foot = document.createElement('div');
    foot.style.cssText = 'font-size:12px;opacity:0.85';
    foot.append(more);

    wrap.append(h, lead, ol, foot);
    el.appendChild(wrap);
    (document.body || document.documentElement).appendChild(el);
  }

  if (!DIRECT) {
    // 短めの ping で在否を判定する(実処理の待ち時間とは分ける)。
    call('ping', {}, 2500).catch(() => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showMissingExtensionNotice, { once: true });
      } else {
        showMissingExtensionNotice();
      }
    });
  }

  // ---- 公開 API(chrome.* と同じ形) ----
  // storage.get は Promise 形式と callback 形式の両方で呼ばれるため、どちらも受ける。
  const storageLocal = {
    get(keys, cb) {
      const p = DIRECT ? chrome.storage.local.get(keys) : call('storage.get', { keys });
      const safe = p.catch(() => ({})); // 取得失敗は「保存なし」として扱い、UI を止めない
      if (typeof cb === 'function') safe.then((r) => cb(r));
      return safe;
    },
    set(items, cb) {
      const p = DIRECT ? chrome.storage.local.set(items) : call('storage.set', { items });
      const safe = p.catch(() => undefined); // 保存失敗で UI を落とさない(次回保存で復帰する)
      if (typeof cb === 'function') safe.then(() => cb());
      return safe;
    }
  };

  window.MV = {
    // 拡張ページとして動いているか(診断・分岐用)
    direct: DIRECT,
    storage: { local: storageLocal },
    runtime: {
      // background.js の onMessage / onMessageExternal 相当へ中継する
      sendMessage(msg) {
        return DIRECT ? chrome.runtime.sendMessage(msg) : call('runtime.sendMessage', { msg });
      }
    },
    system: {
      // content script からは chrome.system.* を呼べないため、通常ページでは background へ回す
      cpu: { getInfo: () => (DIRECT ? chrome.system.cpu.getInfo() : call('system.cpu', {})) },
      memory: { getInfo: () => (DIRECT ? chrome.system.memory.getInfo() : call('system.memory', {})) }
    },
    tabs: {
      create(opts) {
        if (DIRECT) return chrome.tabs.create(opts);
        // 通常ページなら素の window.open で十分(ユーザー操作起点なのでブロックされない)
        window.open(opts && opts.url, '_blank', 'noopener');
        return Promise.resolve();
      }
    }
  };
})();
