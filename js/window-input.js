// 枠の移動・リサイズ・複数選択。

// ====== 複数選択(Shift+クリックでまとめて移動・整形) ======
const selectedWins = new Set();
function toggleMultiSelect(win) {
  if (selectedWins.has(win)) { selectedWins.delete(win); win.el.classList.remove('selected'); }
  else { selectedWins.add(win); win.el.classList.add('selected'); }
}
function clearMultiSelect() {
  selectedWins.forEach((w) => w.el.classList.remove('selected'));
  selectedWins.clear();
}

// 台形ハンドル: つまむ位置で挙動を分ける(RDP風)。
//  - 両端のグリップ(.win-grip): ヘッダを枠の上辺に沿って左右にスライド(両端で止まる)。
//  - 中央の本体(.win-bar-main): つかむと枠を移動。
// ポインタをキャプチャするので iframe/動画の上をドラッグしても追従する。ボタン上では発火しない。
// ポインタドラッグの定型(捕捉 → 移動 → 終了 → 解放)。
// 同じ形を各所で手書きしていたため、setPointerCapture の付け忘れ(右ドラッグでリスナが残る)や
// releasePointerCapture の呼び忘れ(リサイズ)といった取りこぼしが実際に起きていた。ここに集約する。
//
// target を捕捉すると以後の pointer イベントは target に集まるので、クロスオリジン iframe(映像)の
// 上を通っても追従できる。pointerId で絞るのは、2本目の指が同じドラッグを動かしたり終わらせたり
// しないようにするため。戻り値を呼べば途中で終了させられる。
function onPointerDrag(target, e, onMove, onEnd) {
  const pid = e.pointerId;
  try { target.setPointerCapture(pid); } catch (_) { /* noop */ }
  const move = (ev) => { if (ev.pointerId === pid) onMove(ev); };
  const end = (ev) => {
    if (ev && ev.pointerId !== undefined && ev.pointerId !== pid) return;
    try { target.releasePointerCapture(pid); } catch (_) { /* 既に解放済み */ }
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    if (onEnd) onEnd();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  return end;
}

function makeBarHandle(win, bar) {
  bar.addEventListener('pointerdown', (e) => {
    if (stackMode || e.button !== 0 || !e.isPrimary || win.maximized) return; // 縦積み中は移動/スライドなし
    if (e.target.closest('.win-controls, .win-vol')) return; // ボタン/音量バー上は掴まない
    const slideMode = !!e.target.closest('.win-grip'); // 左グリップ=スライド / それ以外=枠移動
    e.preventDefault();
    focusWindow(win);
    const sx = e.clientX;
    const sy = e.clientY;
    const startBarX = win.barX || 0;
    const r = getRect(win);
    bar.classList.add('sliding');
    onPointerDrag(bar, e, (ev) => {
      if (slideMode) {
        win.barX = startBarX + (ev.clientX - sx);
        clampBarX(win); // 枠内+画面内に収めて反映
      } else {
        setRect(win, r.x + (ev.clientX - sx), r.y + (ev.clientY - sy), r.w, r.h);
      }
    }, () => {
      bar.classList.remove('sliding');
      if (slideMode) return; // スライドのみのときは保存しない
      saveLineup(); // 枠を動かしたら位置を保存
    });
  });
}

// dir は 'n','s','e','w' とその組合せ('se' 等)。指定した辺/角からリサイズする。
function beginResize(win, dir, e) {
  if (stackMode || e.button !== 0 || !e.isPrimary || win.maximized) return; // 縦積み中はリサイズなし
  e.preventDefault();
  e.stopPropagation();
  focusWindow(win);
  revealHeader(win); // リサイズ中もヘッダ/隅マークを出し続ける(特にタッチで掴みやすく)
  const cap = e.currentTarget;
  const r = getRect(win);
  const sx = e.clientX;
  const sy = e.clientY;
  onPointerDrag(cap, e, (ev) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    let x = r.x;
    let y = r.y;
    let w = r.w;
    let h = r.h;
    if (dir.includes('e')) w = Math.max(MIN_W, r.w + dx);
    if (dir.includes('s')) h = Math.max(MIN_H, r.h + dy);
    if (dir.includes('w')) { w = Math.max(MIN_W, r.w - dx); x = r.x + r.w - w; } // 右辺を固定
    if (dir.includes('n')) { h = Math.max(MIN_H, r.h - dy); y = r.y + r.h - h; } // 下辺を固定
    setRect(win, x, y, w, h);
  }, () => {
    if (rectResized(r, getRect(win))) stopAutoLayout();
    saveLineup(); // リサイズ後のサイズ・位置を保存
  });
}

function toggleMax(win) {
  if (stackMode) return; // 縦積み中は常に整列済み(⛶ボタン自体も CSS で隠している)
  if (!restoring) stopAutoLayout(); // 最大化を、次の自動配置で解除してしまわないように
  if (win.maximized) {
    if (win.prevRect) setRect(win, win.prevRect.x, win.prevRect.y, win.prevRect.w, win.prevRect.h);
    win.maximized = false;
  } else {
    win.prevRect = getRect(win);
    setRect(win, 4, 4, stage.clientWidth - 8, stage.clientHeight - 8);
    win.maximized = true;
    focusWindow(win);
  }
  saveLineup(); // 最大化/復元の状態を保存(復元中は抑止)
}
