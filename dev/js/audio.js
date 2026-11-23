// 音量・ミュート・枠ごとの遅延。

// ====== 音声 ======
// 方針: 起動時のみ全ミュート(轟音防止)。マスタ音量つまみで全枠まとめて音量を設定できる。
// クロスオリジン埋め込みはタブ出力音を直接絞れないため、各枠の音量をまとめて設定する形。
// つまみ操作時にだけ適用(継続的な上書きはしない)ので、以後は各プレイヤーで個別調整も可能。

// 音量アイコン。0 は専用の形、それ以外は大きさで音の線の本数を変える。
function volIconName(v) {
  if (v <= 0) return 'vol-off';
  if (v < 0.34) return 'vol-low';
  return v < 0.67 ? 'vol-mid' : 'vol-high';
}

// つまみを動かすたびに呼ばれるので、形が変わるときだけ描き直す。
function setVolIcon(el, v) {
  const name = volIconName(v);
  if (el.dataset.icon === name) return;
  el.dataset.icon = name;
  putLabel(el, ':' + name + ':');
}

// アイコンのクリック。鳴っていれば 0 にして今の音量を覚え、0 なら覚えた音量へ戻す。
// つまみで 0 にしたときは覚えた音量が無いので fallback にする。
function nextMuteVolume(cur, remembered, fallback) {
  if (cur > 0) return { vol: 0, remembered: cur };
  return { vol: remembered > 0 ? remembered : fallback, remembered: null };
}

function wireVolIcon(el, onToggle) {
  el.classList.add('vol-toggle');
  el.setAttribute('role', 'button');
  el.title = 'クリックでミュート / 解除';
  el.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  el.addEventListener('dblclick', (e) => e.stopPropagation()); // ヘッダのダブルクリック(最大化)にしない
}

function toggleWinMute(win) {
  const next = nextMuteVolume(win.vol, win.volBeforeMute, WIN_VOLUME_DEFAULT);
  setWinVol(win, next.vol);
  win.volBeforeMute = next.remembered;
  onWinVolCommitted();
}

// マスタの解除先の既定は 50% にしない。実音量は マスタ × 枠 なので、普段の 10% から急に大きくなる。
let masterVolBeforeMute = null;
function toggleMasterMute() {
  const next = nextMuteVolume(masterVolume, masterVolBeforeMute, MASTER_VOLUME_DEFAULT);
  setMasterVolume(next.vol);
  masterVolBeforeMute = next.remembered;
  syncMasterUI();
  saveLineup();
}

function setMasterVolume(v) {
  masterVolBeforeMute = null; // つまみで動かしたら、ミュート前の音量は無効
  masterVolume = v;
  for (const win of wins) applyVolume(win, v);
}

function clampVol(v) {
  v = Number(v);
  // 保存が無い/壊れている場合は既定へ(0 にすると、初めて開いた人が無音で戸惑う)。
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : MASTER_VOLUME_DEFAULT;
}

// マスタ音量つまみ/アイコンを masterVolume に同期させる(ツールバー + ミキサーの両方)。
function syncMasterUI() {
  const v = Math.round(masterVolume * 100);
  const s1 = document.getElementById('master-vol'); if (s1) s1.value = v;
  const i1 = document.getElementById('master-vol-icon'); if (i1) setVolIcon(i1, masterVolume);
  const s2 = document.getElementById('mixer-master'); if (s2) s2.value = v;
  const i2 = document.getElementById('mixer-master-icon'); if (i2) setVolIcon(i2, masterVolume);
}

// 音量を枠へ反映。実音量 = 枠ごと音量(win.vol) × マスタ(v)。
// muted もスライダーが所有する(>0 で解除 / 0 でミュート)。スマホの縦積みではシールドにより
// プレイヤーUIへ触れないため、スライダーだけで確実に音が出る/消えることを保証する。
// 「1つだけ聞く」は他の枠の音量を 0 にして行う(プレイヤー自前のミュートには頼らない)。
// マスタを動かすと全枠が同倍率で増減 → 枠ごとの大小関係(win.vol の比)は保たれる。
// 実際に video.volume を当てるのは枠の中の content script。
function applyVolume(win, v) {
  // 非表示でも音は止めない(👁は見た目を消すだけ)。実音量 = 枠ごと音量 × マスタ。
  const eff = Math.max(0, Math.min(1, (win.vol != null ? win.vol : WIN_VOLUME_DEFAULT) * v));
  postToFrame(win.frame, { type: 'set-volume', value: eff });
}

// ====== 枠ごとの遅延 ======
// 本配信とミラー配信を並べると、同じ音が少しずれて二重に聞こえる。進んでいる側の枠を
// 遅らせて揃えるためのもの。実際に遅らせるのは枠の中(twitch-keepalive.js)で、ここは
// 秒数を持って伝えるだけ。対象は Twitch のライブを埋め込みプレイヤーで映している枠のみ。
const DELAY_MAX_SEC = 20; // twitch-keepalive.js の DELAY_MAX_SEC と合わせる

// 0.01 秒刻みに丸めて 0〜max に収める(ボタンは 0.1 秒刻みだが、音で合わせた値はもっと細かい)。
function clampDelay(sec, max) {
  const v = Math.round(Number(sec) * 100) / 100;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, v));
}

function delaySupported(win) {
  return !!win.light && !!twitchChannelOf(win.url);
}

function setWinDelay(win, sec) {
  win.delay = clampDelay(sec, DELAY_MAX_SEC);
  syncFrameDelay(win);
  if (win.syncDelayUI) win.syncDelayUI();
}

function syncFrameDelay(win) {
  if (!delaySupported(win)) return;
  postToFrame(win.frame, { type: 'set-delay', value: win.delay || 0, hold: !!win.delayHold });
}

// ====== 枠一覧 / ミキサーパネル ======

// 枠ごとの音量を設定し、台形ハンドルとミキサー両方のスライダー表示を同期させる。
function setWinVol(win, v01) {
  win.vol = Math.max(0, Math.min(1, v01));
  win.volBeforeMute = null; // つまみで動かしたら、ミュート前の音量は無効(toggleWinMute は後で入れ直す)
  applyVolume(win, masterVolume);
  syncVolUI(win);
}
function syncVolUI(win) {
  const v = String(Math.round((win.vol != null ? win.vol : WIN_VOLUME_DEFAULT) * 100));
  if (win.volSlider) win.volSlider.value = v;
  if (win.volIcon) setVolIcon(win.volIcon, win.vol);
  const rowEl = document.querySelector('#mixer-panel .mixer-row[data-id="' + win.id + '"]');
  if (!rowEl) return;
  rowEl.querySelector('.mixer-row-vol').value = v;
  setVolIcon(rowEl.querySelector('.mixer-row-vol-icon'), win.vol);
}
