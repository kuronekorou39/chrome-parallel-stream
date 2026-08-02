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

  function call(op, payload) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        // 拡張が入っていない/まだ注入されていない場合はここに来る。
        reject(new Error('拡張機能から応答がありません(未インストールの可能性)'));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ __mv: REQ, id, op, payload }, location.origin);
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
