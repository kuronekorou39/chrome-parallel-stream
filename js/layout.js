// 配置(整列・整形・音量順・自動配置)。

// 配置ダイアログ(#layout-dialog)の開閉と、保存済み一覧の描画。
function openLayoutDialog() {
  if (stackMode) return; // スマホ(縦積み)では配置は使わない(丸ボタンも隠しているが念のため)
  const panel = toggleDialog('layout-dialog', {
    place: placePanelClear, // まず今の内容の大きさで置く
    beforeOpen: () => { document.getElementById('layout-name').value = ''; }
  });
  if (!panel) return;
  renderLayoutList().then(() => { if (!panel.dataset.pinned) placePanelClear(panel); }); // 一覧の高さが確定してから置き直す
}

function closeLayoutDialog() {
  const dlg = document.getElementById('layout-dialog');
  if (dlg) dlg.classList.remove('open');
}

// 整形: 今の配置・大きさを「だいたい保ったまま」、共通グリッドに四辺をスナップして隙間を均一に揃える。
// グリッドのセルは枠の最小サイズ(MIN_W/MIN_H)以上にとるので、小さい枠もきっちり並ぶ。
// 対象は選択枠があればそれだけ、無ければ全表示枠。自由配置モード専用(縦積みは自動レイアウト)。
function snapLayout() {
  if (stackMode) return;
  let list = [...selectedWins].filter((w) => !w.hidden);
  if (list.length < 2) list = wins.filter((w) => !w.hidden && !w.el.classList.contains('stack-max'));
  if (!list.length) return;
  const W = stage.clientWidth, H = stage.clientHeight, gap = SNAP_GAP;
  const cols = Math.max(1, Math.round(W / (MIN_W + gap)));
  const rows = Math.max(1, Math.round(H / (MIN_H + gap)));
  const cellW = W / cols, cellH = H / rows;
  list.forEach((win) => {
    const r = getRect(win);
    const gw = Math.max(1, Math.min(cols, Math.round((r.w + gap) / cellW)));
    const gh = Math.max(1, Math.min(rows, Math.round((r.h + gap) / cellH)));
    const gx = Math.max(0, Math.min(cols - gw, Math.round(r.x / cellW)));
    const gy = Math.max(0, Math.min(rows - gh, Math.round(r.y / cellH)));
    setRect(win, gx * cellW + gap / 2, gy * cellH + gap / 2, gw * cellW - gap, gh * cellH - gap);
  });
  saveLineup();
}

// n 枠を並べる行数・列数を決める。cols を 1..n で総当たりし、セルの比が 16:9 に最も近い分割を選ぶ。
// これにより縦長ステージでは縦積み(1列)になり、各枠が横長を保つ。
function tileGrid(n, W, H, gap) {
  const TARGET = 16 / 9; // 配信は横長動画なので各枠を 16:9 に近づける
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols + 1)) / cols;
    const ch = (H - gap * (rows + 1)) / rows;
    if (cw <= 0 || ch <= 0) continue;
    // 対数比で評価し、縦長/横長のズレを対称に扱う。
    const score = Math.abs(Math.log(cw / ch / TARGET));
    if (!best || score < best.score) best = { cols, rows, score };
  }
  if (best) return { cols: best.cols, rows: best.rows };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

function autoLayoutModeOf(v) {
  return AUTO_LAYOUT_MODES.includes(v) ? v : 'off';
}

function rectResized(a, b) {
  return a.w !== b.w || a.h !== b.h;
}

function syncAutoLayoutUI() {
  document.querySelectorAll('#layout-auto [data-auto]').forEach((box) => {
    box.checked = box.dataset.auto === autoLayout; // 自動は同時に 1 つだけ
  });
  const qa = document.getElementById('qa-layout');
  if (!qa) return;
  const label = AUTO_LAYOUT_LABELS[autoLayout];
  qa.classList.toggle('auto-on', !!label);
  qa.title = label ? '配置(' + label + ')' : '配置';
  qa.setAttribute('aria-label', qa.title);
}

function setAutoLayout(mode) {
  autoLayout = autoLayoutModeOf(mode);
  panelsNeedAvoid = true;
  clearTimeout(autoLayoutTimer);
  syncAutoLayoutUI();
  try { MV.storage.local.set({ [AUTO_LAYOUT_KEY]: autoLayout }); } catch (e) { /* noop */ }
  runAutoLayout();
}

function stopAutoLayout() {
  if (autoLayout !== 'off') setAutoLayout('off');
}

function runAutoLayout() {
  if (autoLayout === 'off' || stackMode || restoring || stackDrag) return;
  animateLayout(autoLayout === 'tile' ? tileAll : layoutByVolume);
}

// 並べ直しを短いアニメーションで見せる(一瞬で変わると、どの枠がどこへ行ったか見逃すため)。
// left/top/width/height を動かすと iframe の中まで毎フレーム再レイアウトされて重いので、
// 先に最終位置へ置き、元の位置に見える transform から戻す。
const LAYOUT_ANIM_MS = 220;
function animateLayout(run) {
  // 裏のタブは描画されないので動かしても見えない。OS で動きを減らす設定の人にも動かさない。
  if (stackMode || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    run();
    return;
  }
  // 動いている途中で次の並べ直しが来ても、今見えている位置から続くように、止める前に測る。
  const before = new Map(wins.filter((w) => !w.hidden).map((w) => [w, w.el.getBoundingClientRect()]));
  before.forEach((_, w) => { if (w.layoutAnim) w.layoutAnim.cancel(); });
  run();
  before.forEach((from, w) => {
    const transform = layoutAnimFrom(from, w.el.getBoundingClientRect());
    if (!transform) return;
    w.layoutAnim = w.el.animate(
      [{ transformOrigin: '0 0', transform }, { transformOrigin: '0 0', transform: 'none' }],
      { duration: LAYOUT_ANIM_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    );
  });
}

// 最終位置 to に置いた枠を、元の位置 from に見せる transform。動いていなければ null。
function layoutAnimFrom(from, to) {
  if (!to.width || !to.height) return null;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return null;
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

function scheduleAutoLayout() {
  panelsNeedAvoid = true;
  if (autoLayout === 'off' || stackMode || restoring) return;
  clearTimeout(autoLayoutTimer);
  autoLayoutTimer = setTimeout(runAutoLayout, AUTO_LAYOUT_DEBOUNCE_MS);
}

// 枠の音量を確定したとき(つまみを離したとき)。動かしている最中に枠が動くと操作できないので、ここで並べ直す。
function onWinVolCommitted() {
  saveLineup();
  if (autoLayout === 'volume') scheduleAutoLayout();
}

// 配置ボタンを手で押したとき。自動と違う方式を選んだら、次の変化で戻されないよう自動をオフにする。
function runManualLayout(kind, run) {
  panelsNeedAvoid = true;
  if (!stackMode && autoLayout !== kind) stopAutoLayout();
  animateLayout(run);
}

// 複数窓をタイル整列(2つメイン+残りサブにしたい時の起点)。
function tileAll() {
  if (stackMode) {
    relayoutStack(); // 縦積み中の「整列」= 積み直し
    return;
  }
  const vis = wins.filter((w) => !w.hidden); // 隠している枠にマスを割り当てると、空きができる
  if (!vis.length) return;
  const gap = 4;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const { cols, rows } = tileGrid(vis.length, W, H, gap);
  const cw = Math.floor((W - gap * (cols + 1)) / cols);
  const ch = Math.floor((H - gap * (rows + 1)) / rows);
  vis.forEach((win, i) => {
    win.maximized = false;
    const c = i % cols;
    const r = Math.floor(i / cols);
    setRect(win, gap + c * (cw + gap), gap + r * (ch + gap), cw, ch);
  });
  saveLineup(); // 整列後の配置を保存(復元中の初回フォールバックでは restoring で抑止)
}

// 音量の大きい枠ほど大きく並べ直す。「主に聞いている配信が主役、他は横目で追う」を
// そのまま画面にする。音量は既に自分で決めているので、大きさを決め直す手間が要らない。
//
// 決め方: 大きさは音量だけで決める(面積 ∝ 音量。辺はその平方根)。枠は全部 16:9 のまま。
// 音量の大きい順に横へ詰め、幅を超えたら次の行へ。全体の倍率だけを二分探索で決めて画面に収める。
// 行を横幅いっぱいに引き伸ばす方式(写真の敷き詰め)も試したが、行ごとに倍率が変わるせいで
// 「同じ音量なのに大きさが違う」が起きるので採らない。面積を音量に正確に比例させるほうを優先し、
// 余りは中央寄せで余白として見せる(隙間なく敷き詰めることとは両立しない)。
// 重みの下限。0 だと消えるので置くが、高くすると、それ以下の音量をいくら変えても大きさが変わらなくなる。
const VOL_LAYOUT_FLOOR = 0.04;
const VOL_LAYOUT_ASPECT = 16 / 9; // 配信は横長。枠はこの比を保つ
function layoutByVolume() {
  if (stackMode) { relayoutStack(); return; } // 縦積みは全幅固定なので大きさを変えられない
  const vis = wins.filter((w) => !w.hidden);
  if (!vis.length) return;
  const gap = 6;
  const W = stage.clientWidth - gap * 2;
  const H = stage.clientHeight - gap * 2;
  // 重みは「枠ごとの音量」。マスタは全枠に同じだけ掛かるので大小関係に影響しない。
  const items = vis
    .map((win) => ({ win, r: Math.sqrt(Math.max(VOL_LAYOUT_FLOOR, win.vol != null ? win.vol : WIN_VOLUME_DEFAULT)) }))
    .sort((a, b) => b.r - a.r);

  // 画面に収まる範囲でいちばん大きい倍率を探す(行の折り返しが飛び飛びに変わるので二分探索)。
  let lo = 10, hi = Math.max(H, W), best = null;
  for (let i = 0; i < 30; i++) {
    const base = (lo + hi) / 2;
    const p = packVolumeRows(items, W, gap, base, MIN_H);
    if (p.totalH <= H && p.rows.every((row) => row.w <= W)) { best = { rows: p.rows, totalH: p.totalH, base }; lo = base; }
    else { hi = base; }
  }
  if (!best) { const p = packVolumeRows(items, W, gap, 60, MIN_H); best = { rows: p.rows, totalH: p.totalH, base: 60 }; }

  // 音量が小さすぎる枠は最小サイズで止める(そのぶん面積の比例は崩れるが、読めない大きさで
  // 並べても意味が無い)。詰める計算も同じ大きさで行うので、枠どうしは重ならない。
  const heightOf = (it) => Math.max(MIN_H, best.base * it.r);
  let y = gap + Math.max(0, (H - best.totalH) / 2); // 余りは上下に散らす
  best.rows.forEach((row) => {
    const rowH = Math.max(...row.items.map(heightOf));
    let x = gap + Math.max(0, (W - row.w) / 2); // 行は横中央へ
    row.items.forEach((it) => {
      const h = heightOf(it);
      const w = h * VOL_LAYOUT_ASPECT;
      it.win.maximized = false;
      setRect(it.win, Math.round(x), Math.round(y + (rowH - h) / 2), Math.round(w), Math.round(h));
      x += w + gap;
    });
    y += rowH + gap;
  });
  saveLineup();
}

// 指定の倍率で、音量の大きい順に横へ詰めていく。幅を超えたら次の行。引き伸ばしはしない。
// minH = 枠の高さの下限(これより小さくは置かない)。
function packVolumeRows(items, W, gap, base, minH = 0) {
  const heightOf = (it) => Math.max(minH, base * it.r);
  const rows = [];
  let cur = [], curW = 0;
  for (const it of items) {
    const w = heightOf(it) * VOL_LAYOUT_ASPECT;
    const next = curW ? curW + gap + w : w;
    if (cur.length && next > W) { rows.push({ items: cur, w: curW }); cur = [it]; curW = w; }
    else { cur.push(it); curW = next; }
  }
  if (cur.length) rows.push({ items: cur, w: curW });
  let totalH = 0;
  rows.forEach((row, i) => { totalH += Math.max(...row.items.map(heightOf)) + (i ? gap : 0); });
  return { rows, totalH };
}

// 配置ダイアログ(📐 配置)の配線。整列・整形は即実行して閉じ、保存は一覧へ反映する。
function setupLayoutDialog() {
  // 整列/整形を実行してもダイアログは閉じない(× だけで閉じる)。実行後すぐ別の操作・微調整ができる。
  const tile = document.getElementById('layout-tile');
  if (tile) tile.addEventListener('click', () => runManualLayout('tile', tileAll));
  const snap = document.getElementById('layout-snap');
  if (snap) snap.addEventListener('click', () => runManualLayout('snap', snapLayout));
  const byVol = document.getElementById('layout-volume');
  if (byVol) byVol.addEventListener('click', () => runManualLayout('volume', layoutByVolume));
  document.querySelectorAll('#layout-auto [data-auto]').forEach((box) => {
    box.addEventListener('change', () => setAutoLayout(box.checked ? box.dataset.auto : 'off'));
  });
  syncAutoLayoutUI();
  const nameInput = document.getElementById('layout-name');
  const save = document.getElementById('layout-save');
  const doSave = async () => {
    await saveLayout(nameInput ? nameInput.value : '');
    if (nameInput) nameInput.value = '';
    renderLayoutList();
  };
  if (save) save.addEventListener('click', doSave);
  if (nameInput) nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  setupDialog('layout-dialog');
}
