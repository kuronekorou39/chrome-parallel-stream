// スマホの縦積みと、長押しでの並び替え。

// ====== スマホ縦積みモード ======
// 指が主ポインタかつ狭い画面では、自由配置WMをやめて「全幅×16:9 の縦並びタイル」にする。
// タッチで辛い精密操作(移動・リサイズ・重なり)を封印し、タップとスクロールだけで完結させる。
// 並び順はミキサー(一覧)の ▲▼ で入替。自由配置の座標は freeRect に退避し、戻る時に復元する。

function updateStackMode() {
  const on = stackMq.matches || location.hash === '#stack';
  if (on === stackMode) return;
  stackMode = on;
  document.body.classList.toggle('stack-mode', on);
  toggleMainMenu(false); // モード切替をまたいでメニューを残さない
  closeLayoutDialog();    // 配置はスマホ非対応。モード切替時に開きっぱなしにしない
  if (on) {
    wins.forEach((w) => {
      w.freeRect = w.maximized && w.prevRect ? w.prevRect : getRect(w);
      w.maximized = false;
    });
    relayoutStack();
  } else {
    wins.forEach((w) => {
      clearStackMax(w); // 全画面状態は縦積み専用
      const r = w.freeRect;
      w.freeRect = null;
      if (r) setRect(w, r.x, r.y, r.w, r.h);
    });
    scheduleAutoLayout(); // 縦積みの間に枠が増減していても合わせる
  }
  wins.forEach((w) => sendTheaterEnabled(w, on && !w.light)); // モード切替を各フレームへ(軽量はシアター不要)
  wins.forEach((w) => applyFrameZoom(w)); // 既定縮小率がモードで変わる(自由配置=等倍 / 縦積み=75/50%)
  wins.forEach((w) => syncMenuModeVisibility(w)); // PCでは幅/高さ/縮小を隠す(縦積み専用のため)
  renderMixer(); // ▲▼(並び替え)の出し分けを更新
}

// 表示中の枠を上から順に積む。setRect は使わない(ステージ高でクランプされるため)。
// 幅: 100%(full)=1行に1枠 / 50%(half)=横に2枠まで(span)。並び順で隣り合う half 同士がペアになる。
// 高さ: 既定は全枠 16:9。⋮メニューの「高さ切替」で枠ごとに縦長(STACK_TALL_RATIO)へできる(win.tall)。
// ツールバーはステージに重なるオーバーレイなので、上/左/右配置の間はその分タイルを避ける。
function relayoutStack() {
  if (!stackMode) return;
  const gap = 6;
  const cs = document.body.classList;
  const tb = document.getElementById('toolbar');
  const offTop = cs.contains('tb-pos-top') ? tb.offsetHeight : 0;
  const offSide = cs.contains('tb-pos-left') || cs.contains('tb-pos-right') ? tb.offsetWidth : 0;
  const x0 = gap + (cs.contains('tb-pos-left') ? offSide : 0);
  const fullW = Math.max(180, stage.clientWidth - offSide - gap * 2);
  const halfW = Math.floor((fullW - gap) / 2);
  const tallH = Math.round(stage.clientHeight * STACK_TALL_RATIO);

  const vis = wins.filter((w) => !w.hidden);
  let y = gap + offTop;
  let i = 0;
  while (i < vis.length) {
    const win = vis[i];
    // half が2つ連続するなら横並び(1行に2枠)。それ以外は単独で1行。
    const pair = win.span === 'half' && i + 1 < vis.length && vis[i + 1].span === 'half' ? vis[i + 1] : null;
    if (pair) {
      const h = Math.max(stackTileH(win, halfW), stackTileH(pair, halfW));
      placeTile(win, x0, y, halfW, h);
      placeTile(pair, x0 + halfW + gap, y, halfW, h);
      y += h + gap;
      i += 2;
    } else {
      const w = win.span === 'half' ? halfW : fullW; // 相方のいない half は左寄せの半幅で出す
      const h = stackTileH(win, w, tallH);
      placeTile(win, x0, y, w, h);
      y += h + gap;
      i += 1;
    }
  }
  // 末尾に余白の番兵を置き、最後のタイルが下配置ツールバーの裏に隠れず最後までスクロールできるようにする。
  // さらに画面ぶんの空きを足して、要素が無くても下へスクロールできるようにする。下端は ≡ メニューが
  // 重なるうえ、枠の中の入力欄(チャット)を触るとキーボードが出て画面の下半分が埋まるため、
  // 最後のタイルを上へ送れる余地が要る。空白に見えるのは意図したもの。
  let pad = document.getElementById('stack-pad');
  if (!pad) {
    pad = document.createElement('div');
    pad.id = 'stack-pad';
    pad.style.cssText = 'position:absolute;width:1px;height:1px;visibility:hidden;';
    stage.appendChild(pad);
  }
  pad.style.left = '0px';
  // バーは縦積みでは非表示(offsetHeight=0)のため、≡メニューぶんの最低余白は常に確保する。
  const gapForBar = Math.max(72, cs.contains('tb-pos-bottom') ? tb.offsetHeight : 0);
  pad.style.top = (y + gapForBar + Math.round(stage.clientHeight * STACK_TAIL_RATIO)) + 'px';
}

// 縦積みでチャットに足す高さ。
// コメントは弾幕で読めるので、一覧まで出す必要がない。入力欄だけを残す
// (CSS 側で枠の下端に合わせて切り出す)。全サイト共通(Kick も 0.9.58 から弾幕に対応)。
// 半幅(横に2つ)のときは、そもそも入力欄が使える大きさにならないので出さない。
function stackChatH(win) {
  if (!win.body) return 0;
  if (!win.body.classList.contains('split-chat') || !win.body.classList.contains('chat-on')) return 0;
  if (win.span === 'half') return 0;
  // 「高さ」で縦長を選んだ枠は、増えたぶんをチャットにも回して一覧まで出す。
  // 16:9 のままなら入力欄だけ(コメントは弾幕で読める)。これで高さの選択が効くようになる。
  if (isTall(win)) return STACK_CHAT_H;
  return STACK_CHAT_INPUT_H;
}

// 縦積みタイルの高さを幅から算出。既定は 16:9(Kickはチャット分を加算)。
// 縦長(手動指定)は全幅時のみ反映。half(横並び)は小さく出す枠なので常に 16:9。
function stackTileH(win, w, tallH) {
  let h = Math.round((w * 9) / 16);
  h += stackChatH(win);
  if (tallH && win.span !== 'half' && isTall(win)) h = Math.max(h, tallH);
  return h;
}

function placeTile(win, x, y, w, h) {
  win.stackRect = { x, y, w, h }; // 確定後のタイル位置(ドラッグ並び替えの挿入判定が参照する)
  win.el.style.left = x + 'px';
  win.el.style.top = y + 'px';
  win.el.style.width = w + 'px';
  win.el.style.height = h + 'px';
  updateWinWidthClass(win, w);
  updateWinShapeClass(win, w, h);
  clampBarX(win);
}

// ====== 縦積み: 長押しドラッグ並び替え(ホーム画面風) ======
// タイルを長押しすると「浮き」、そのままドラッグで並び替えられる。すぐ動かした場合は通常の
// スクロールとして扱う(しきい値超えで長押しキャンセル)。長押しが届くのは親がポインタを受け
// られる面= 通常枠(シールド)と Kick(映像)。軽量(iframe)枠は右上の ⠿ ハンドルから掴む。
const LONG_PRESS_MS = 450; // 長押し成立までの静止時間
const LONG_PRESS_SLOP = 10; // これ以上動いたら長押しではなくスクロール操作とみなす
const DRAG_SCROLL_ZONE = 60; // 画面上下端の自動スクロール開始ゾーン
const DRAG_SCROLL_MAX = 16; // 自動スクロールの最大速度(px/フレーム)
let stackDrag = null; // 進行中のドラッグ状態(同時に1つ)
const STUCK_DRAG_MS = 8000; // これより古い stackDrag は終了処理の取りこぼし(残骸)とみなして畳む

// 終了処理を取りこぼして残った stackDrag を畳む保険。残ると以後どの枠も掴めなくなるため、
// 新たに掴むたびに呼び、一定時間より古い残骸なら強制終了する。掴み直してよければ true を返す。
// (全画面化や iframe 再読込で pointerup / tile-drag-end を受け損ねると残骸になる)
function reapStuckDrag() {
  if (!stackDrag) return true;
  if (Date.now() - (stackDrag.t0 || 0) < STUCK_DRAG_MS) return false; // まだ進行中らしい
  if (stackDrag.pid != null) endStackDrag(); else finishStackDrag(); // ローカル/リモートで畳み方を分ける
  return !stackDrag;
}

function maybeStartLongPress(win, e) {
  if (!e.isPrimary || e.button !== 0) return;
  // 縦積み(スマホ)では長押しドラッグでの並び替えをしない。指の動きに左右されて成否が読めず、
  // スクロールとも取り合いになる。並び替えは ⋮メニューの ▲▼ で確実にできる。
  if (stackMode) return;
  if (!reapStuckDrag()) return; // 進行中ドラッグがあれば新規は掴ませない(古い残骸なら畳んで継続)
  if (win.el.classList.contains('stack-max')) return;
  if (e.target.closest('.win-quick, .win-menu, .win-badge, .win-adjust, .win-bar, .win-resize-grip, button, input')) return;
  const pid = e.pointerId;
  const sx = e.clientX, sy = e.clientY;
  let lx = sx, ly = sy;
  const timer = setTimeout(() => {
    cleanup();
    beginStackDrag(win, { pointerId: pid, clientX: lx, clientY: ly });
  }, LONG_PRESS_MS);
  const onMove = (ev) => {
    if (ev.pointerId !== pid) return;
    lx = ev.clientX;
    ly = ev.clientY;
    if (Math.abs(lx - sx) > LONG_PRESS_SLOP || Math.abs(ly - sy) > LONG_PRESS_SLOP) cleanup(); // スクロールへ
  };
  const cleanup = () => {
    clearTimeout(timer);
    win.el.removeEventListener('pointermove', onMove);
    win.el.removeEventListener('pointerup', cleanup);
    win.el.removeEventListener('pointercancel', cleanup);
  };
  win.el.addEventListener('pointermove', onMove);
  win.el.addEventListener('pointerup', cleanup);
  win.el.addEventListener('pointercancel', cleanup);
}

// 右ボタンのドラッグ(マウス): 長押し不要で即つかんで移動。押下では始めず、少し動いた時点で開始する
// (純粋な右クリックでは何も起きないように。右クリックメニューは contextmenu 抑止で出さない)。動き始めたら
// 通常のドラッグ機構(beginStackDrag: setPointerCapture + onStackDragMove)へ引き継ぐ。
function armRightDrag(win, e) {
  if (win.el.classList.contains('stack-max')) return;
  const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
  let started = false;
  const onMove = (ev) => {
    if (ev.pointerId !== pid || started) return;
    if (Math.abs(ev.clientX - sx) > LONG_PRESS_SLOP || Math.abs(ev.clientY - sy) > LONG_PRESS_SLOP) {
      started = true;
      cleanup();
      beginStackDrag(win, ev);
    }
  };
  const onUp = (ev) => { if (ev.pointerId === pid) cleanup(); };
  const cleanup = () => {
    try { win.el.releasePointerCapture(pid); } catch (_) { /* 既に解放済み */ }
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
  };
  // ポインタを捕捉しておかないと、枠内のクロスオリジン iframe(映像)の上で指を離したとき
  // 親に pointerup が届かず cleanup が走らない。右クリックのたびにリスナが積み上がる。
  try { win.el.setPointerCapture(pid); } catch (_) { /* noop */ }
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
}

// ドラッグ状態の生成と「浮かせる」見た目の適用(ローカル=親ポインタ / リモート=frame内中継 共通)。
// mode: 'stack'=縦積みの並び替え / 'free'=自由配置の任意位置移動。レイアウト(stackMode)で決まる。
function startStackDragState(win, clientX, clientY) {
  if (win.el.classList.contains('stack-max')) return false;
  if (!reapStuckDrag()) return false; // 残骸なら畳んでから掴む(frame 中継ドラッグ経路の保険)
  focusWindow(win); // 浮いてる間は最前面に
  revealHeader(win);
  win.el.classList.remove('menu-open');
  win.el.classList.add('dragging');
  const mode = stackMode ? 'stack' : 'free';
  // 自由配置: 掴んだ枠が複数選択に含まれていれば、選択枠をまとめて移動。含まなければ選択解除して単独移動。
  const groupMove = mode === 'free' && selectedWins.has(win) && selectedWins.size > 1;
  if (mode === 'free' && !groupMove) clearMultiSelect();
  const group = (groupMove ? [...selectedWins] : [win]).map((w) => {
    const rr = getRect(w);
    w.el.classList.add('dragging');
    return { w, sl: w.el.offsetLeft, st: w.el.offsetTop, gw: rr.w, gh: rr.h };
  });
  if (mode === 'stack') document.body.classList.add('reordering'); // 他タイルが席を空けるアニメ(縦積みのみ)
  // マウスのネイティブな選択・ドラッグ&ドロップ(リンク/画像/テキスト)を抑止する。これをしないと
  // 移動中に dragstart が起きてポインタ捕捉が外れ、「リンクを掴んだ」状態で離れてしまう。
  document.addEventListener('dragstart', blockNativeDrag, true);
  document.addEventListener('selectstart', blockNativeDrag, true);
  try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (_) { /* noop */ }
  if (navigator.vibrate) {
    try { navigator.vibrate(20); } catch (_) { /* noop */ } // 「浮いた」感触
  }
  stackDrag = {
    win, mode, group,
    t0: Date.now(), // 開始時刻。終了処理を取りこぼした古い残骸の検出(reapStuckDrag)に使う
    pid: null, // ローカルドラッグのときだけ設定
    remoteSrc: null, remoteSX: 0, remoteSY: 0, // リモートドラッグ(frame内中継)のときだけ設定
    startX: clientX, startY: clientY,
    lastX: clientX, lastY: clientY,
    startLeft: win.el.offsetLeft, startTop: win.el.offsetTop,
    startScroll: stage.scrollTop,
    lastReorder: 0,
    raf: null, autoV: 0
  };
  return true;
}

// ドラッグの移動処理。free=指の位置へ枠(選択していれば全部)を移動 / stack=浮かせて並び替え。
function applyDragMove() {
  const d = stackDrag;
  if (d.mode === 'free') {
    const dx = d.lastX - d.startX, dy = d.lastY - d.startY;
    d.group.forEach((g) => setRect(g.w, g.sl + dx, g.st + dy, g.gw, g.gh));
  } else {
    updateDragPos();
    updateAutoScroll();
    maybeReorderAt();
  }
}

function beginStackDrag(win, e) {
  if (!startStackDragState(win, e.clientX, e.clientY)) return;
  stackDrag.pid = e.pointerId;
  try { win.el.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  win.el.addEventListener('pointermove', onStackDragMove);
  win.el.addEventListener('pointerup', endStackDrag);
  win.el.addEventListener('pointercancel', endStackDrag);
  // 長押し成立時点ではネイティブスクロール未開始なので、以後の touchmove を止めれば
  // ドラッグ中にスクロールへ奪われない。
  win.el.addEventListener('touchmove', blockTouchScroll, { passive: false });
}

// frame 内の content script(stream-control.js)から中継される長押しドラッグ。
// 開始時に iframe の画面内位置 + frame内クライアント座標で親クライアント系へ校正し、
// 以後の移動は screen 座標の差分で追う(タイルごと iframe が動いても screen はぶれない)。
// メッセージの送り主(frame の window)から、どの枠かを引く。映像側とチャット側のどちらから
// 来ても同じ枠を返す(枠の中の操作は、どちらのフレームからでも中継されてくるため)。
function winOfSource(src) {
  return wins.find((w) =>
    (w.frame && w.frame.contentWindow === src) ||
    (w.chatFrame && w.chatFrame.contentWindow === src));
}

function onTileDragMsg(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true) return;
  if (d.type === 'tile-drag-start') {
    if (stackMode) return; // 縦積みでは長押しドラッグを使わない(▲▼ で並び替える)
    const win = winOfSource(e.source);
    if (!win) return;
    const frameEl = win.frame && win.frame.contentWindow === e.source ? win.frame : win.chatFrame;
    const r = frameEl.getBoundingClientRect();
    // 縮小表示(🔍 transform scale)中は frame 内クライアント座標が見た目より大きいので比率で補正。
    const k = frameEl.offsetWidth ? r.width / frameEl.offsetWidth : 1;
    if (!startStackDragState(win, r.left + d.cx * k, r.top + d.cy * k)) return;
    stackDrag.remoteSrc = e.source;
    stackDrag.remoteSX = d.sx;
    stackDrag.remoteSY = d.sy;
  } else if (d.type === 'tile-drag-move') {
    const s = stackDrag;
    if (!s || !s.remoteSrc || s.remoteSrc !== e.source) return;
    s.lastX = s.startX + (d.sx - s.remoteSX);
    s.lastY = s.startY + (d.sy - s.remoteSY);
    applyDragMove();
  } else if (d.type === 'tile-drag-end') {
    const s = stackDrag;
    if (!s || !s.remoteSrc || s.remoteSrc !== e.source) return;
    finishStackDrag();
  } else if (d.type === 'tile-shift-click') {
    // frame 上での Shift+クリック → その枠を複数選択にトグル。
    const win = winOfSource(e.source);
    if (win) { toggleMultiSelect(win); revealHeader(win); }
  } else if (d.type === 'tile-raise') {
    // frame 内で右クリック → ドラッグ前でもその枠を即最前面へ(重なりの下から出す)。
    const win = winOfSource(e.source);
    if (win) { focusWindow(win); revealHeader(win); }
  } else if (d.type === 'tile-tap') {
    // 枠の中(別オリジンの iframe)のタップ。親には届かないので content script が中継してくる。
    // 枠の縁を狙わなくても、どこを触ってもその枠が選ばれ、✕/⋮ が出るようにする。
    // focusWindow は DOM のフォーカスを奪わないので、枠の中で文字を打っている最中でも邪魔しない。
    const win = winOfSource(e.source);
    if (win) { focusWindow(win); revealHeader(win); }
  }
}

function blockTouchScroll(e) {
  if (e.cancelable) e.preventDefault();
}

// ドラッグ中のネイティブD&D/テキスト選択を止める(startDragState で登録、finishStackDrag で解除)。
function blockNativeDrag(e) {
  e.preventDefault();
}

function onStackDragMove(ev) {
  const d = stackDrag;
  if (!d || d.remoteSrc || ev.pointerId !== d.pid) return;
  d.lastX = ev.clientX;
  d.lastY = ev.clientY;
  applyDragMove();
}

// 浮いてるタイルを指に追従させる(ステージのスクロール分も補正)。
function updateDragPos() {
  const d = stackDrag;
  d.win.el.style.left = (d.startLeft + d.lastX - d.startX) + 'px';
  d.win.el.style.top = (d.startTop + (d.lastY - d.startY) + (stage.scrollTop - d.startScroll)) + 'px';
}

// 画面の上下端へ近づけたら一覧を自動スクロール(遠くへ運べるように)。
function updateAutoScroll() {
  const d = stackDrag;
  const r = stage.getBoundingClientRect();
  const tz = d.lastY - r.top;
  const bz = r.bottom - d.lastY;
  d.autoV = tz < DRAG_SCROLL_ZONE ? -Math.ceil(DRAG_SCROLL_MAX * (1 - Math.max(0, tz) / DRAG_SCROLL_ZONE))
    : bz < DRAG_SCROLL_ZONE ? Math.ceil(DRAG_SCROLL_MAX * (1 - Math.max(0, bz) / DRAG_SCROLL_ZONE)) : 0;
  if (d.autoV && !d.raf) autoScrollTick();
}

function autoScrollTick() {
  const d = stackDrag;
  if (!d || !d.autoV) {
    if (d) d.raf = null;
    return;
  }
  stage.scrollTop += d.autoV;
  updateDragPos();
  maybeReorderAt();
  d.raf = requestAnimationFrame(autoScrollTick);
}

// 指の位置(ステージ内容座標)から挿入先を決め、変わっていれば並びを入れ替える。
// 判定は確定レイアウト(stackRect)基準。120ms に1回へ間引いて境界での振動を抑える。
// 全幅タイル: 縦の中点を跨いだら入れ替え(指の左右位置は見ない)。
// 50%タイル: 行内の左右は横の中心で判定(左右スワップ用)、行をまたぐ移動は行の上端で判定。
function maybeReorderAt() {
  const d = stackDrag;
  const now = Date.now();
  if (now - d.lastReorder < 120) return;
  const r = stage.getBoundingClientRect();
  const cx = d.lastX - r.left;
  const cy = d.lastY - r.top + stage.scrollTop;
  const vis = wins.filter((w) => !w.hidden && w !== d.win);
  let idx = vis.length;
  for (let k = 0; k < vis.length; k++) {
    const t = vis[k].stackRect;
    if (!t) continue;
    if (vis[k].span === 'half') {
      if (cy < t.y) { idx = k; break; } // この行より上 → この前へ
      if (cy <= t.y + t.h && cx < t.x + t.w / 2) { idx = k; break; } // 同じ行で中心より左 → この前へ
    } else if (cy < t.y + t.h / 2) {
      idx = k; // 縦の中点より上 → この前へ
      break;
    }
  }
  const cur = wins.indexOf(d.win);
  let target = idx < vis.length ? wins.indexOf(vis[idx]) : wins.length;
  if (cur < target) target -= 1; // 自分を抜いた後の挿入位置に補正
  if (target === cur) return;
  wins.splice(cur, 1);
  wins.splice(target, 0, d.win);
  d.lastReorder = now;
  relayoutStack(); // 他のタイルが席を空ける(reordering 中は CSS でスルッと動く)
  updateDragPos(); // relayoutStack が浮いてるタイルも置き直すため、指の位置へ戻す
}

function endStackDrag(ev) {
  const d = stackDrag;
  if (!d || d.remoteSrc || (ev && ev.pointerId !== d.pid)) return;
  d.win.el.removeEventListener('pointermove', onStackDragMove);
  d.win.el.removeEventListener('pointerup', endStackDrag);
  d.win.el.removeEventListener('pointercancel', endStackDrag);
  d.win.el.removeEventListener('touchmove', blockTouchScroll);
  try { d.win.el.releasePointerCapture(d.pid); } catch (_) { /* noop */ }
  finishStackDrag();
}

// ドラッグ終了の共通処理(ローカル/リモート)。stack は並びを確定して滑り込ませ、free はその場で確定。
function finishStackDrag() {
  const d = stackDrag;
  if (!d) return;
  stackDrag = null;
  document.removeEventListener('dragstart', blockNativeDrag, true);
  document.removeEventListener('selectstart', blockNativeDrag, true);
  if (d.raf) cancelAnimationFrame(d.raf);
  (d.group || [{ w: d.win }]).forEach((g) => g.w.el.classList.remove('dragging')); // まとめ移動の全枠
  if (d.mode === 'stack') {
    relayoutStack(); // reordering のアニメが残っている間に席へ滑り込む
    setTimeout(() => document.body.classList.remove('reordering'), 200);
  }
  saveLineup();
  renderMixer();
}
