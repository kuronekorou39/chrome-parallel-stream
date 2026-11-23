// ポップアップの位置決め・開閉・ドラッグ。

// ログインCookie(SameSite)を埋め込みフレームへ送れるよう background で緩めてから
// src を読み込む。これでフレーム内でログイン状態になり、チャット投稿などができる。
// 🍪 ログインCookie ダイアログ。切り替えと「元に戻す」を置く。
// 枠内のログインは対象サイトの Cookie の SameSite 変更に依存し、その変更はブラウザ全体へ効く。
// 黙って変えるのではなく、利用者が選べて戻せる状態にしておく。
function openCookieDialog() {
  toggleDialog('cookie-dialog', {
    beforeOpen: () => {
      document.getElementById('cookie-relax').checked = cookieRelaxOn;
      document.getElementById('cookie-status').textContent = '';
    }
  });
}

// 拡張機能ダイアログ。押した瞬間にダウンロードが始まると何が落ちてきたのか分からないので、
// 版と手順を見せてから落とさせる。中身は checkExtVersion が埋めている。
function openUpdateDialog() {
  toggleDialog('update-dialog');
}

function setupCookieDialog() {
  setupDialog('cookie-dialog');

  const toggle = document.getElementById('cookie-relax');
  toggle.addEventListener('change', () => {
    cookieRelaxOn = toggle.checked;
    MV.storage.local.set({ [COOKIE_RELAX_KEY]: cookieRelaxOn });
    document.getElementById('cookie-status').textContent = cookieRelaxOn
      ? 'ON にしました。次に枠を読み込むときから適用されます。'
      : 'OFF にしました。変更済みの Cookie は下のボタンで戻せます。';
  });

  const status = document.getElementById('cookie-status');
  const restoreBtn = document.getElementById('cookie-restore');
  restoreBtn.addEventListener('click', async () => {
    restoreBtn.disabled = true;
    status.textContent = '戻しています…';
    try {
      const resp = await MV.runtime.sendMessage({ type: 'restore-cookies' });
      // 記録(recorded)が無いのに 0 件と出ると「壊れている」ように見えるので、理由を出し分ける。
      // 記録は戻した時点で消えるので、続けて押せば必ず 0 件になる。
      status.textContent = !resp || !resp.ok
        ? '戻せませんでした。'
        : !resp.recorded
          ? '戻す Cookie はありません。'
          : resp.restored === resp.recorded
            ? `${resp.restored} 件の Cookie を元の設定に戻しました。枠を読み込み直すと反映されます。`
            : `${resp.restored} 件を戻しました(${resp.recorded - resp.restored} 件は Cookie が既に無いため対象外)。`;
    } catch (e) {
      status.textContent = '戻せませんでした: ' + e.message;
    } finally {
      restoreBtn.disabled = false;
    }
  });

  MV.storage.local.get(COOKIE_RELAX_KEY, (d) => {
    // 未設定なら既定 ON(これまでの挙動を変えない)。
    cookieRelaxOn = d && d[COOKIE_RELAX_KEY] !== undefined ? d[COOKIE_RELAX_KEY] !== false : true;
    toggle.checked = cookieRelaxOn;
  });
}

// 汎用: ハンドルをつかんで要素を移動(ステージ内にクランプ)。ミキサーパネル用。
// 浮動パネルを最前面へ持ち上げる(パネルどうしの重なり順だけを変える。コンテンツ枠やメニューの帯は別バンド)。
// zEl = z-index を持つ最上位要素(ミキサー/perf はパネル本体、ダイアログは overlay)。
function raisePanel(zEl) {
  if (zEl) zEl.style.zIndex = ++panelZ;
}

// パネルを「掴む/フォーカス(=どこかを pointerdown)したら最前面」にする配線。
// hitEl = 当たり判定を取る要素(操作する見える本体)、zEl = 実際に z を上げる要素(省略時は hitEl)。
// capture:true で、ドラッグ開始やボタン押下より先に確実に前面化する。
function wirePanelRaise(hitEl, zEl) {
  if (!hitEl) return;
  hitEl.addEventListener('pointerdown', () => raisePanel(zEl || hitEl), true);
}

// 浮動パネル/ダイアログ(枠を追加・配置・枠一覧・パフォーマンス)を、開く直前に画面中央へ置き直す。
// 基準は offsetParent の内寸: position:absolute は最も近い配置済み祖先(ダイアログはオーバーレイ=全面、
// ミキサーはステージ等)、position:fixed は offsetParent が null になるのでビューポートを使う。
// 要素が表示状態(display!=none)でないと offsetWidth が測れないので、表示にしてから呼ぶこと。
// 毎回中央へ戻すので前回ドラッグ位置は引き継がない(機能パネルは常に中央から出すのが分かりやすい)。
function centerPanel(el) {
  if (!el) return;
  el.style.right = 'auto';   // bottom/right が残っていると left/top と競合するので解除してから中央寄せ
  el.style.bottom = 'auto';
  const p = el.offsetParent; // fixed 要素は null → ビューポート基準
  const cw = p ? p.clientWidth : window.innerWidth;
  const ch = p ? p.clientHeight : window.innerHeight;
  el.style.left = Math.max(0, Math.round((cw - el.offsetWidth) / 2)) + 'px';
  el.style.top = Math.max(0, Math.round((ch - el.offsetHeight) / 2)) + 'px';
}

// 下端へ寄せる(横は中央)。縦積み(スマホ)はタイルが上から順に積まれるので、中央に出すと
// 追加したそばから枠に隠れてしまう。続けて追加する間、積み上がる様子が見えるようにする。
function placePanelBottom(el) {
  if (!el) return;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  const p = el.offsetParent;
  const cw = p ? p.clientWidth : window.innerWidth;
  const ch = p ? p.clientHeight : window.innerHeight;
  el.style.left = Math.max(0, Math.round((cw - el.offsetWidth) / 2)) + 'px';
  el.style.top = Math.max(0, Math.round(ch - el.offsetHeight - PANEL_EDGE_GAP)) + 'px';
}

// ====== ポップアップを、枠や他のポップアップに被らない場所へ置く ======
// 開くときに一度置き、その後は枠の並びが変わったときだけ、無操作で表示が消えている間に動かす。
// 見えているものや操作中のものは動かさない。手でドラッグしたものは閉じるまで動かさない(dataset.pinned)。
const PANEL_EDGE_GAP = 12;
const PANEL_UI_WEIGHT = 3;       // 他のポップアップやボタンに被るのは、枠に被るより避ける
const PANEL_WIN_BASE_WEIGHT = 0.25; // 枠の重み = これ + 音量(音の小さい枠の上を優先して使う)
const PANEL_MOVE_MIN_GAIN = 0.7; // 重なりがこの割合未満まで減るときだけ動かす(わずかな改善で動かさない)
const PANEL_MOVE_AFTER_FADE_MS = 250; // 消えるフェード(0.2 秒)が終わってから動かす

// 長方形 r が障害物に重なっている量(面積 × 重み)。
function panelOverlapCost(r, obstacles) {
  let cost = 0;
  for (const o of obstacles) {
    const ow = Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x);
    const oh = Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y);
    if (ow > 0 && oh > 0) cost += ow * oh * o.weight;
  }
  return cost;
}

// w×h のパネルを W×H の中で、重なりがいちばん少ない位置に置く。同じなら中央に近いほう。
// 候補は四隅・中央と、各障害物のすぐ隣(空きがあるなら、必ずどれかの候補がそこに当たる)。
function pickPanelPos(w, h, W, H, obstacles, gap) {
  const maxX = Math.max(gap, W - w - gap);
  const maxY = Math.max(gap, H - h - gap);
  const xs = [gap, maxX, (gap + maxX) / 2];
  const ys = [gap, maxY, (gap + maxY) / 2];
  for (const o of obstacles) {
    xs.push(o.x - w - gap, o.x + o.w + gap);
    ys.push(o.y - h - gap, o.y + o.h + gap);
  }
  let best = null;
  for (const x of xs) {
    if (x < gap || x > maxX) continue;
    for (const y of ys) {
      if (y < gap || y > maxY) continue;
      const cost = panelOverlapCost({ x, y, w, h }, obstacles);
      const dist = Math.hypot(x - (gap + maxX) / 2, y - (gap + maxY) / 2);
      if (!best || cost < best.cost - 1 || (Math.abs(cost - best.cost) <= 1 && dist < best.dist)) {
        best = { x: Math.round(x), y: Math.round(y), cost, dist };
      }
    }
  }
  return best;
}

// el の親を基準にした座標で、避ける相手の一覧を作る。
function panelObstacles(el) {
  const par = el.offsetParent;
  const pr = par ? par.getBoundingClientRect() : { left: 0, top: 0 };
  const toObstacle = (node, weight) => {
    const r = node.getBoundingClientRect();
    return { x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height, weight };
  };
  const list = wins
    .filter((w) => !w.hidden)
    .map((w) => toObstacle(w.el, PANEL_WIN_BASE_WEIGHT + (w.vol != null ? w.vol : WIN_VOLUME_DEFAULT)));
  document.querySelectorAll(
    '#mixer-panel:not([hidden]), .pos-dialog-overlay.open .pos-dialog, #perf-panel:not([hidden]), ' +
    '#danmaku-panel:not([hidden]), #main-menu:not([hidden]), #quick-actions'
  ).forEach((node) => { if (node !== el) list.push(toObstacle(node, PANEL_UI_WEIGHT)); });
  return list;
}

function panelBounds(el) {
  const p = el.offsetParent;
  return { W: p ? p.clientWidth : window.innerWidth, H: p ? p.clientHeight : window.innerHeight };
}

function placePanelClear(el) {
  if (!el) return;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  const { W, H } = panelBounds(el);
  const pos = pickPanelPos(el.offsetWidth, el.offsetHeight, W, H, panelObstacles(el), PANEL_EDGE_GAP);
  el.style.left = pos.x + 'px';
  el.style.top = pos.y + 'px';
}

// 自動で動かす対象のうち、いま開いているもの。
function openClearPanels() {
  const mixer = document.getElementById('mixer-panel');
  return [
    mixer && !mixer.hidden ? mixer : null,
    document.querySelector('#add-dialog.open .pos-dialog'),
    document.querySelector('#layout-dialog.open .pos-dialog')
  ].filter(Boolean);
}

// 無操作で表示が消えている間に、枠に被ったポップアップを避ける。
// hovered = 消える直前にポインタが乗っていたもの(すぐ触る可能性が高いので動かさない)。
function avoidPanels(hovered) {
  if (!panelsNeedAvoid || stackMode) return;
  let deferred = false;
  const active = document.activeElement;
  for (const el of openClearPanels()) {
    if (el.dataset.pinned) continue;
    if (hovered.includes(el) || (el.contains(active) && active.matches('input:not([type="range"])'))) {
      deferred = true; // 次に消えたときにやり直す
      continue;
    }
    const obstacles = panelObstacles(el);
    const cur = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    const curCost = panelOverlapCost(cur, obstacles);
    if (curCost <= 0) continue;
    const { W, H } = panelBounds(el);
    const next = pickPanelPos(cur.w, cur.h, W, H, obstacles, PANEL_EDGE_GAP);
    if (next.cost >= curCost * PANEL_MOVE_MIN_GAIN) continue;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.left = next.x + 'px';
    el.style.top = next.y + 'px';
  }
  panelsNeedAvoid = deferred;
}

// 右下の丸ボタンに、対応するポップアップが開いているかを出す。閉じる経路が多いので、状態の変化を監視する。
function setupQuickButtonState() {
  const pairs = [
    ['qa-mixer', 'mixer-panel', (el) => !el.hidden],
    ['qa-add', 'add-dialog', (el) => el.classList.contains('open')],
    ['qa-layout', 'layout-dialog', (el) => el.classList.contains('open')]
  ];
  pairs.forEach(([btnId, panelId, isOpen]) => {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) return;
    const sync = () => btn.classList.toggle('panel-open', isOpen(panel));
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden', 'class'] });
    sync();
  });
}

// ====== 移動できるダイアログ(.pos-dialog-overlay > .pos-dialog)の共通処理 ======
// 開くたびに置き直して最前面へ出す。もう一度押したら閉じる。開いたときはパネルを、それ以外は null を返す。
function toggleDialog(id, { place = centerPanel, beforeOpen } = {}) {
  const dlg = document.getElementById(id);
  if (!dlg) return null;
  if (dlg.classList.contains('open')) {
    dlg.classList.remove('open');
    return null;
  }
  const panel = dlg.querySelector('.pos-dialog');
  delete panel.dataset.pinned;
  if (beforeOpen) beforeOpen(panel);
  place(panel);
  raisePanel(dlg); // z は overlay 側で上げる
  dlg.classList.add('open');
  return panel;
}

// ✕(id + '-close')で閉じ、ヘッダ帯で動かせるようにする。枠外クリックでは閉じない
// (下のステージを操作できるようにするため。≡メニューから開いた直後の click で閉じる事故も防ぐ)。
function setupDialog(id) {
  const dlg = document.getElementById(id);
  if (!dlg) return;
  document.getElementById(id + '-close').addEventListener('click', () => dlg.classList.remove('open'));
  const panel = dlg.querySelector('.pos-dialog');
  makePanelDraggable(panel, panel.querySelector('.pos-dialog-head'));
  wirePanelRaise(panel, dlg);
}

function makePanelDraggable(el, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (e.target.closest('button, input')) return; // ボタン/つまみ上は移動しない
    e.preventDefault();
    // 現在の見た目の位置を読み取ってから left/top 基準に固定し、その後で bottom/right を外す。
    // (bottom 基準のパネル=perf を先に 'auto' にすると、その瞬間に静的位置=左上へ飛んでしまう)
    const sl = el.offsetLeft, st = el.offsetTop;
    el.style.left = sl + 'px';
    el.style.top = st + 'px';
    el.style.bottom = 'auto';
    el.style.right = 'auto';
    const sx = e.clientX, sy = e.clientY;
    // ドラッグ中は全 iframe を無反応にする。クロスオリジン iframe の上を通るとポインタが
    // そちらへ吸われて掴めなくなる(「下に枠があると持てない」)ため、物理的に通させない。
    document.body.classList.add('panel-dragging');
    // 収める範囲は「left/top の基準になっている親」で測る。ステージ直下のパネル(枠一覧など)は
    // ステージ、枠に貼り付いたパネル(映像調整)はその枠。ここをステージ固定にすると、枠の中の
    // パネルが枠の外まで動かせてしまい、枠の overflow:hidden で消える。
    const par = el.offsetParent; // position:fixed のパネルは null → ステージ(≒ビューポート)で測る
    const cw = par ? par.clientWidth : stage.clientWidth;
    const ch = par ? par.clientHeight : stage.clientHeight;
    onPointerDrag(handle, e, (ev) => {
      // 枠と同じく EDGE_KEEP px を親の中に残してはみ出しを許容する。
      // 上はドラッグハンドル(ヘッダ)がパネル先頭にあるので 0 で止める(出すと掴めなくなる)。
      const minL = EDGE_KEEP - el.offsetWidth;
      const maxL = cw - EDGE_KEEP;
      const maxT = Math.max(0, ch - EDGE_KEEP);
      el.style.left = Math.max(minL, Math.min(maxL, sl + ev.clientX - sx)) + 'px';
      el.style.top = Math.max(0, Math.min(maxT, st + ev.clientY - sy)) + 'px';
    }, () => {
      document.body.classList.remove('panel-dragging');
      if (el.offsetLeft !== sl || el.offsetTop !== st) el.dataset.pinned = '1'; // 置いた場所を尊重する
    });
  });
}

// 枠一覧パネルの下端ハンドルで縦リサイズ。高さは [MIN_H, 画面に収まる範囲] にクランプして保存(次回復元)。
function makeMixerResizable(panel, handle) {
  const MIN_H = 200;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    document.body.classList.add('panel-dragging'); // ドラッグ中は iframe にポインタを奪わせない(掴み外れ防止)
    onPointerDrag(handle, e, (ev) => {
      const maxH = Math.max(MIN_H, stage.clientHeight - panel.offsetTop - 8); // 下端が画面外へ出ないように
      panel.style.height = Math.max(MIN_H, Math.min(maxH, startH + ev.clientY - startY)) + 'px';
    }, () => {
      document.body.classList.remove('panel-dragging');
      panel.dataset.userResized = '1'; // 起動時の復元が後から来ても、この操作を巻き戻さない
      try { MV.storage.local.set({ [MIXER_HEIGHT_KEY]: panel.offsetHeight }); } catch (_) { /* noop */ }
    });
  });
}
