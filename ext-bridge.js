// multiview の UI ページから拡張機能の機能を使うための薄い橋渡し。multiview.js より先に読むこと。
//
// UI ページは通常の https オリジン(GitHub Pages)に置く。拡張ページ(chrome-extension://)の中の
// iframe には他の拡張の content script が一切注入されず(Chrome の仕様。executeScript も
// "Cannot access contents of the page" で弾かれる)、広告スキッパー等が枠に効かないため。
//
// ページからは chrome.* を直接使えないので、拡張が同オリジンへ注入する page-bridge.js へ
// postMessage で依頼し、結果を受け取る。呼び出し側は MV.* を chrome.* と同じ形で使える。
(function extBridge() {
  'use strict';

  const HOSTED_URL = 'https://kuronekorou39.github.io/chrome-parallel-stream/multiview.html';
  const REPO_URL = 'https://github.com/kuronekorou39/chrome-parallel-stream';
  // リポジトリ全体ではなく、拡張機能のファイルだけを詰めた配布物を指す。
  // 展開したフォルダがそのまま拡張機能になるので、入れ子を掘る必要がない
  // (スマホのファイル操作でこれが効く)。tools/release.mjs が作る。
  // リンク先は常に存在する固定名にする。版入りの URL を直接指すと、古いページを開いたままの
  // 利用者が、既に消えた版を掴んで 404 になる(実際に起きた)。
  // 保存されるファイル名だけ download 属性で版入りにする。
  const ZIP_URL = 'dist/parallel-stream-latest.zip';
  const ZIP_NAME = 'parallel-stream-0.9.18.zip'; // release.mjs が版に合わせて書き換える

  // 拡張はリポジトリのルートを丸ごと読み込むため、multiview.html は拡張パッケージにも含まれ、
  // chrome-extension://<ID>/multiview.html でも開けてしまう。ただしそこでは広告ブロックが
  // 効かないので、開かれたら黙って正しい方へ転送する(古いブックマークもこれで直る)。
  if (location.protocol === 'chrome-extension:') {
    location.replace(HOSTED_URL + location.search + location.hash);
    return;
  }

  const REQ = 'mvBridgeReq';
  const RES = 'mvBridgeRes';
  const TIMEOUT_MS = 5000;

  let seq = 0;
  const pending = new Map();

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

  // ---- 公開 API(chrome.* と同じ形) ----
  // storage.get は Promise 形式と callback 形式の両方で呼ばれるため、どちらも受ける。
  const storageLocal = {
    get(keys, cb) {
      const p = call('storage.get', { keys }).catch(() => ({})); // 失敗は「保存なし」扱いで UI を止めない
      if (typeof cb === 'function') p.then((r) => cb(r));
      return p;
    },
    set(items, cb) {
      const p = call('storage.set', { items }).catch(() => undefined); // 保存失敗で UI を落とさない
      if (typeof cb === 'function') p.then(() => cb());
      return p;
    }
  };

  window.MV = {
    storage: { local: storageLocal },
    runtime: {
      // background.js の onMessage へ中継する(Cookie 緩和・Kick の再生URL取得)
      sendMessage: (msg) => call('runtime.sendMessage', { msg })
    },
    system: {
      // content script からは chrome.system.* を呼べないため background へ回す
      cpu: { getInfo: () => call('system.cpu', {}) },
      memory: { getInfo: () => call('system.memory', {}) }
    },
    tabs: {
      create(opts) {
        // ユーザー操作起点なのでブロックされない
        window.open(opts && opts.url, '_blank', 'noopener');
        return Promise.resolve();
      }
    }
  };

  // ---- 拡張機能が入っていないときの案内 ----
  // このページは UI だけで、枠の埋め込み(CSP/X-Frame-Options の除去)も枠内の音量・弾幕も
  // 拡張機能側が担っている。拡張が無いと枠が真っ白なまま理由も分からないので、手順ごと明示する。
  // chrome://extensions はウェブページからリンクにしても Chrome が遷移を拒否するため、
  // クリックさせず「コピーして貼る」形で見せる。
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
    zip.download = ZIP_NAME;
    zip.textContent = 'ZIP をダウンロード';
    zip.style.cssText = 'color:#ff9c94;font-weight:bold';
    li(zip, ' して展開する(展開したフォルダがそのまま拡張機能です)');
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

  // 短めの ping で在否を判定する(実処理の待ち時間とは分ける)。
  // 応答に入っている拡張のバージョンは MV.extVersion に置き、ページ側が新旧の比較に使う。
  call('ping', {}, 2500).then((r) => {
    MV.extVersion = (r && r.version) || null;
    window.dispatchEvent(new CustomEvent('mv-ext-ready'));
  }).catch(() => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showMissingExtensionNotice, { once: true });
    } else {
      showMissingExtensionNotice();
    }
  });
})();
