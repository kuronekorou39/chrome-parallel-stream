// multiview の UI ページが通常の https オリジンに置かれたときの中継役(content script / ISOLATED world)。
//
// ページ側の ext-bridge.js が window.postMessage で依頼を投げてくるので、それを chrome.* で実行して返す。
// chrome.storage は content script から直接使えるが、chrome.system.* / chrome.tabs.* は使えないため、
// それらは background.js へ転送する。
//
// 注入対象は manifest の content_scripts で自分のページのオリジンに限定している。ページと content script は
// window を共有するので、e.source === window の確認だけで第三者フレームからの偽装は弾ける。
(function pageBridge() {
  'use strict';

  const REQ = 'mvBridgeReq';
  const RES = 'mvBridgeRes';

  function reply(id, ok, result, error) {
    try {
      window.postMessage({ __mv: RES, id, ok, result, error }, location.origin);
    } catch (e) { /* noop */ }
  }

  async function handle(op, payload) {
    switch (op) {
      // 拡張機能が入っているかの確認用。応答があれば繋がっている。
      // バージョンも返す。ページ側(GitHub Pages)は勝手に新しくなるが拡張は手動更新なので、
      // ずれたままだと「直したはずの不具合が直らない」状態になる。ページ側で気づけるようにする。
      case 'ping':
        return { ok: true, version: chrome.runtime.getManifest().version };
      case 'storage.get':
        return chrome.storage.local.get(payload.keys);
      case 'storage.set':
        return chrome.storage.local.set(payload.items);
      case 'runtime.sendMessage':
        return chrome.runtime.sendMessage(payload.msg);
      // content script からは chrome.system.* を呼べないので background に投げる
      case 'system.cpu':
        return chrome.runtime.sendMessage({ type: 'bridge-system-cpu' });
      case 'system.memory':
        return chrome.runtime.sendMessage({ type: 'bridge-system-memory' });
      case 'tabs.create':
        return chrome.runtime.sendMessage({ type: 'bridge-open-tab', url: payload.url });
      default:
        throw new Error('unknown op: ' + op);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return; // 自ページからの依頼のみ(埋め込まれた第三者フレームを弾く)
    const d = e.data;
    if (!d || d.__mv !== REQ || typeof d.id !== 'number') return;
    handle(d.op, d.payload || {})
      .then((result) => reply(d.id, true, result))
      .catch((err) => reply(d.id, false, undefined, err && err.message ? err.message : String(err)));
  });
})();
