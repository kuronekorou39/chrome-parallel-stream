// 入っている拡張機能の版の確認。

// ====== 拡張機能のバージョン確認 ======
// ページ(GitHub Pages)は開き直せば最新になるが、拡張機能は手動で更新しないと古いまま残る。
// ずれていると「直したはずの不具合が直らない」状態になり、原因を探る時間が丸ごと無駄になる。
// ページが期待する版と、実際に入っている拡張の版を突き合わせて、古ければその場で知らせる。
// この値はリリース手順で manifest.json と一緒に更新すること。
const EXPECTED_EXT_VERSION = '1.0.19';
// リンク先は版入りのファイル名にする。download 属性で保存名だけ変える方式は、別オリジンからの
// リンクや一部のブラウザ(Android の自作ブラウザ等)で効かず、latest 名のまま落ちて (1)(2) が付く。
// 版入りの zip は tools/release.mjs が消さずに残すので、古いページを開いたままの利用者も 404 にならない。
const EXT_ZIP_NAME = 'parallel-stream-' + EXPECTED_EXT_VERSION + '.zip';
const EXT_ZIP_URL = 'dist/' + EXT_ZIP_NAME;

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function checkExtVersion() {
  const v = MV.extVersion;
  // メニューの「拡張機能」は、新しい版があるときだけ出す。
  const sub = document.getElementById('mm-update-ver');
  const item = document.getElementById('mm-update');
  const old = v && cmpVersion(v, EXPECTED_EXT_VERSION) < 0;
  if (sub && item) {
    sub.textContent = old ? v + ' → ' + EXPECTED_EXT_VERSION : '';
    item.classList.toggle('is-old', !!old);
    item.hidden = !old;
    item.title = '拡張機能の新しい版があります';
  }
  const ver = document.getElementById('mm-ver');
  if (ver) ver.textContent = v || '';
  // ダイアログの中身も同じ情報で埋めておく(開いたときに作らない)。
  const cur = document.getElementById('upd-cur');
  const latest = document.getElementById('upd-latest');
  const note = document.getElementById('upd-note');
  const updDl = document.getElementById('upd-dl');
  if (cur) cur.textContent = v || '(未検出)';
  if (latest) latest.textContent = EXPECTED_EXT_VERSION;
  if (note) {
    note.textContent = !v
      ? '拡張機能が見つかりません。下から取得して読み込んでください。'
      : old
        ? '新しい版があります。更新すると、このページが期待する動作になります。'
        : '最新です。更新の必要はありません。';
  }
  if (updDl) {
    updDl.href = EXT_ZIP_URL; // 版入りの zip(消さないので古いページからでも 404 にならない)
    updDl.download = EXT_ZIP_NAME;
  }
  if (!v || cmpVersion(v, EXPECTED_EXT_VERSION) >= 0) return;
  if (document.getElementById('mv-ext-old')) return;
  // 拡張機能がないときの赤い帯(ext-bridge.js)と同じ形で、色だけ黄色にする。
  // 最初は一言とダウンロードのボタンだけ。手順は押したあとに帯の中へ出す。
  // 古いままでも使えはするので、こちらは閉じられるようにする。
  const make = (tag, props, ...kids) => {
    const n = Object.assign(document.createElement(tag), props || {});
    n.append(...kids);
    return n;
  };
  const dl = make('a', { className: 'eo-btn eo-primary', href: EXT_ZIP_URL, download: EXT_ZIP_NAME, textContent: '新しい版をダウンロード' });
  const how = make('button', { type: 'button', className: 'eo-how', textContent: '入れ替え方を見る' });
  const done = make('button', { type: 'button', className: 'eo-btn eo-ghost', hidden: true, textContent: '入れ替えたので開き直す' });
  const close = make('button', { type: 'button', className: 'eo-btn eo-ghost', textContent: '閉じる' });
  const steps = make('ol', { hidden: true },
    make('li', null, 'ダウンロードした ZIP を展開する'),
    make('li', null, make('code', { textContent: 'chrome://extensions' }), ' を開き、古い Parallel Stream を削除する'),
    make('li', null, '「パッケージ化されていない拡張機能を読み込む」で、展開したフォルダを選ぶ')
  );
  const openSteps = () => {
    steps.hidden = false;
    done.hidden = false;
    how.hidden = true;
  };
  dl.addEventListener('click', openSteps);
  how.addEventListener('click', openSteps);
  done.addEventListener('click', () => location.reload());
  const row = make('div', { className: 'eo-row' },
    make('span', { textContent: '拡張機能の新しい版があります(' + v + ' → ' + EXPECTED_EXT_VERSION + ')。' }), dl, how, done, close);
  const el = make('div', { id: 'mv-ext-old' }, row, steps);
  close.addEventListener('click', () => el.remove());
  (document.body || document.documentElement).appendChild(el);
}
