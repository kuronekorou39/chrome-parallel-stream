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
  // 開かれたときの URL。multiview.js は受け取った ?add= を URL から消すので、拡張機能を入れた
  // あとに開き直す先として、消される前のものを控えておく(渡された配信を失わないため)。
  const ENTRY_URL = location.href;
  // リポジトリ全体ではなく、拡張機能のファイルだけを詰めた配布物を指す。
  // 展開したフォルダがそのまま拡張機能になるので、入れ子を掘る必要がない
  // (スマホのファイル操作でこれが効く)。tools/release.mjs が作る。
  // リンク先は版入りのファイル名にする(download 属性で保存名だけ変える方式は、環境によって効かず
  // latest 名のまま落ちて (1)(2) が付く)。版入りの zip は release.mjs が消さずに残すので 404 にならない。
  const ZIP_NAME = 'parallel-stream-0.9.68.zip'; // release.mjs が版に合わせて書き換える
  const ZIP_URL = 'dist/' + ZIP_NAME;

  // 拡張はリポジトリのルートを丸ごと読み込むため、multiview.html は拡張パッケージにも含まれ、
  // chrome-extension://<ID>/multiview.html でも開けてしまう。ただしそこでは広告ブロックが
  // 効かないので、開かれたら黙って正しい方へ転送する(古いブックマークもこれで直る)。
  //
  // 例外は ?dev=1。GitHub Pages は release ブランチを配るので、作業中(main)の UI を確かめる
  // 場所がここしか無い。転送せず、拡張ページとして開いたまま動かす。
  // 拡張ページでは page-bridge.js が注入されない代わりに chrome.* をそのまま呼べるので、
  // MV.* は同じ形のまま中身を直呼びに差し替える(呼び出し側=multiview.js は何も変えない)。
  if (location.protocol === 'chrome-extension:') {
    if (!/(^|[?&])dev=1(&|$)/.test(location.search)) {
      location.replace(HOSTED_URL + location.search + location.hash);
      return;
    }
    const cb2 = (p, cb) => { if (typeof cb === 'function') p.then((r) => cb(r)); return p; };
    window.MV = {
      storage: {
        local: {
          get: (keys, cb) => cb2(chrome.storage.local.get(keys).catch(() => ({})), cb),
          set: (items, cb) => cb2(chrome.storage.local.set(items).catch(() => undefined), cb)
        }
      },
      runtime: { sendMessage: (msg) => chrome.runtime.sendMessage(msg) },
      system: {
        cpu: { getInfo: () => chrome.system.cpu.getInfo() },
        memory: { getInfo: () => chrome.system.memory.getInfo() }
      },
      tabs: {
        create(opts) {
          window.open(opts && opts.url, '_blank', 'noopener');
          return Promise.resolve();
        }
      },
      extVersion: chrome.runtime.getManifest().version
    };
    window.addEventListener('load', () => window.dispatchEvent(new CustomEvent('mv-ext-ready')));
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
  // このページは UI だけで、枠の埋め込みも枠内の音量・弾幕も拡張機能側が担っている。
  // 拡張が無いと枠が真っ白なまま理由も分からないので、画面の上端に赤い帯で知らせる。
  // 最初に出すのは一言とダウンロードのボタンだけ。手順はボタンを押したあとに帯の中へ出す
  // (押す前から全部並べると、読む量に押されて入れてもらえない)。
  // chrome://extensions はウェブページからリンクにしても Chrome が遷移を拒否するため、
  // クリックさせず、選択してコピーできる文字として見せる。
  const NOTICE_CSS = [
    '#mv-no-ext{position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:12px 18px;max-height:70vh;overflow:auto;',
    'background:#1b0d0f;color:#ffdcd9;border-bottom:1px solid #f85149;box-shadow:0 4px 18px rgba(0,0,0,0.6);',
    'font:14px/1.7 system-ui,sans-serif}',
    '#mv-no-ext .ne-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 14px}',
    '#mv-no-ext .ne-btn{padding:6px 16px;border-radius:6px;border:1px solid #f85149;font:inherit;font-weight:bold;',
    'text-decoration:none;cursor:pointer}',
    '#mv-no-ext .ne-primary{background:#f85149;color:#fff}',
    '#mv-no-ext .ne-primary:hover{background:#ff6a63}',
    '#mv-no-ext .ne-ghost{background:transparent;color:#ffdcd9}',
    '#mv-no-ext .ne-ghost:hover{background:#3a1518}',
    '#mv-no-ext .ne-how{padding:0;border:0;background:none;color:#ff9c94;font:inherit;text-decoration:underline;cursor:pointer}',
    '#mv-no-ext ol{max-width:620px;margin:10px auto 0;padding:10px 0 0 1.4em;border-top:1px solid #5a2326;font-size:13px}',
    '#mv-no-ext li{margin-bottom:4px}',
    '#mv-no-ext code{padding:1px 6px;border-radius:4px;background:#000;color:#ffd9d5;',
    'font-family:ui-monospace,Consolas,monospace;user-select:all}',
    '#mv-no-ext [hidden]{display:none}'
  ].join('');
  // 手順を開いたことはタブの中だけで覚える。入れ終えて戻ってきたときの開き直しを挟んでも、
  // まだ入っていなければ同じ手順の表示に戻すため。
  const NOTICE_OPEN_KEY = 'mvNoExtSteps';

  function showMissingExtensionNotice() {
    if (document.getElementById('mv-no-ext')) return;

    const make = (tag, props, ...kids) => {
      const n = Object.assign(document.createElement(tag), props || {});
      n.append(...kids);
      return n;
    };
    const received = new URLSearchParams(new URL(ENTRY_URL).search).has('add');
    const reopen = () => location.replace(ENTRY_URL);

    const style = make('style', { textContent: NOTICE_CSS });
    const lead = received
      ? '拡張機能を入れると、受け取った配信が並びます。'
      : '拡張機能を入れると、配信を並べて見られます。';
    const zip = make('a', { className: 'ne-btn ne-primary', href: ZIP_URL, download: ZIP_NAME, textContent: '拡張機能をダウンロード' });
    const how = make('button', { type: 'button', className: 'ne-how', textContent: '入れ方を見る' });

    const steps = make('ol', { hidden: true },
      make('li', null, 'ダウンロードした ZIP を展開する'),
      make('li', null, make('code', { textContent: 'chrome://extensions' }), ' を開き、デベロッパーモードを ON にする'),
      make('li', null, '「パッケージ化されていない拡張機能を読み込む」で、展開したフォルダを選ぶ')
    );
    const done = make('button', { type: 'button', className: 'ne-btn ne-ghost', hidden: true, textContent: '入れたので開き直す' });
    done.addEventListener('click', reopen);

    const openSteps = () => {
      steps.hidden = false;
      done.hidden = false;
      how.hidden = true;
      try { sessionStorage.setItem(NOTICE_OPEN_KEY, '1'); } catch (e) { /* noop */ }
    };
    zip.addEventListener('click', openSteps);
    how.addEventListener('click', openSteps);
    let wasOpen = false;
    try { wasOpen = sessionStorage.getItem(NOTICE_OPEN_KEY) === '1'; } catch (e) { /* noop */ }
    if (wasOpen) openSteps();

    // 拡張機能は、入れた時点で開いていたタブには効かない(開き直して初めて繋がる)。
    // 手順の途中で別のタブやフォルダへ行き、戻ってきたら開き直して確かめる。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !steps.hidden) reopen();
    });

    const row = make('div', { className: 'ne-row' }, make('span', { textContent: lead }), zip, how, done);
    const el = make('div', { id: 'mv-no-ext' }, style, row, steps);
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
