// マルチビュー本体ページの「ページ内ウィンドウマネージャ」。
// storage(MULTIVIEW_ACTIVE_KEY)の URL 群を読み、各配信を iframe のフローティング窓として
// ステージ上に並べる。ドラッグ移動・右下リサイズ・重ね(z-order)・最大化・整列に対応。
// 音声はクロスオリジンで直接触れないため、各フレームの content script(stream-control.js)へ
// postMessage で muted/volume を指示する。起動時は全ミュート、各窓の S(ソロ)で1つだけ鳴らす。

const MULTIVIEW_ACTIVE_KEY = 'multiviewActive';
const MULTIVIEW_SETTINGS_KEY = 'multiviewSettings';
const MAX_WINDOWS = 10;
const MAGIC = '__multiviewControl';
const IFRAME_ALLOW = 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write';

// ツールバーのワンクリックで開く主要4サイト(各サイトのトップを開き、枠内でライブを選ぶ)。
const SITES = {
  twitch: { url: 'https://www.twitch.tv/' },
  youtube: { url: 'https://www.youtube.com/' },
  kick: { url: 'https://kick.com/' },
  openrec: { url: 'https://www.openrec.tv/' }
};

const stage = document.getElementById('stage');
const stageEmpty = document.getElementById('stage-empty');
const shield = document.getElementById('shield');
const countEl = document.getElementById('count');

let zCounter = 10;
let idSeq = 0;
let activeWin = null;
const master = { volume: 1.0, muted: true };
const wins = [];

(async function init() {
  wireToolbar();
  window.addEventListener('message', onFrameMessage);
  window.addEventListener('resize', relayoutOnResize);

  const data = await chrome.storage.local.get([MULTIVIEW_ACTIVE_KEY, MULTIVIEW_SETTINGS_KEY]);
  applySettings(data[MULTIVIEW_SETTINGS_KEY] || {});

  const urls = ((data[MULTIVIEW_ACTIVE_KEY] || {}).urls || [])
    .map((u) => (u || '').trim())
    .filter((u) => u.length > 0)
    .slice(0, MAX_WINDOWS);

  urls.forEach((u) => createWindow(u, { silent: true }));
  tileAll();
  updateCount();
})();

// popup の設定(起動時ミュート・マスタ音量初期値)を master に反映し、ツールバー UI を合わせる。
function applySettings(s) {
  master.muted = s.startMuted !== false; // 既定 ON
  master.volume = typeof s.masterVolume === 'number' ? Math.max(0, Math.min(1, s.masterVolume)) : 1;
  document.getElementById('master-vol').value = Math.round(master.volume * 100);
  updateMasterMuteUI();
}

// 現在の配信ラインナップを storage に保存(専用ページを開き直すと復元される)。
function saveLineup() {
  const urls = wins.map((w) => w.url);
  try {
    chrome.storage.local.set({ [MULTIVIEW_ACTIVE_KEY]: { urls, timestamp: new Date().toISOString() } });
  } catch (e) {
    /* noop */
  }
}

// ====== ウィンドウ生成 ======

function createWindow(url, opts = {}) {
  if (wins.length >= MAX_WINDOWS) return null;
  const id = 'w' + ++idSeq;

  const el = document.createElement('div');
  el.className = 'win';
  el.style.zIndex = ++zCounter;

  const bar = document.createElement('div');
  bar.className = 'win-bar';
  const title = document.createElement('div');
  title.className = 'win-title';
  title.textContent = labelFor(url);

  const controls = document.createElement('div');
  controls.className = 'win-controls';
  const muteBtn = mkBtn('🔇', 'muted', 'ミュート切替');
  const soloBtn = mkBtn('S', '', 'ソロ(これだけ音を出す)');
  const maxBtn = mkBtn('⛶', '', '最大化/復元');
  const closeBtn = mkBtn('✕', 'close', '閉じる');
  controls.append(muteBtn, soloBtn, maxBtn, closeBtn);
  bar.append(title, controls);

  const body = document.createElement('div');
  body.className = 'win-body';
  const frame = document.createElement('iframe');
  frame.src = toEmbedUrl(url);
  // allow に fullscreen を含むので allowfullscreen 属性は付けない(コンソール警告回避)。
  frame.allow = IFRAME_ALLOW;
  body.appendChild(frame);

  // OpenRec はログイン cookie(SameSite)を iframe に引き継げないため、注意書きを出す。
  if (hostOf(url).includes('openrec.tv')) {
    body.appendChild(makeNote('⚠ OpenRec はログイン状態を引き継げません(別サイト扱いのため未ログイン表示になります)'));
  }

  const resize = document.createElement('div');
  resize.className = 'win-resize';

  el.append(bar, body, resize);
  stage.appendChild(el);

  const win = { id, url, el, frame, muteBtn, muted: true, maximized: false, prevRect: null };
  wins.push(win);

  const i = wins.length - 1;
  setRect(win, 40 + (i % 6) * 30, 40 + (i % 6) * 30, 520, 320);

  el.addEventListener('mousedown', () => focusWindow(win));
  makeDraggable(win, bar);
  makeResizable(win, resize);
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(win); });
  soloBtn.addEventListener('click', (e) => { e.stopPropagation(); soloWindow(win); });
  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(win); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(win); });
  bar.addEventListener('dblclick', () => toggleMax(win));
  frame.addEventListener('load', () => sendAudio(win));

  focusWindow(win);
  updateWinAudioUI(win);
  if (!opts.silent) {
    updateCount();
    saveLineup();
  }
  return win;
}

function mkBtn(label, cls, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  if (title) b.title = title;
  return b;
}

// 枠の上部に出す、×で閉じられる注意バナー。
function makeNote(text) {
  const note = document.createElement('div');
  note.className = 'win-note';
  const span = document.createElement('span');
  span.textContent = text;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'win-note-x';
  x.textContent = '✕';
  x.addEventListener('click', (e) => { e.stopPropagation(); note.remove(); });
  note.append(span, x);
  return note;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// ====== 位置・サイズ ======

function setRect(win, x, y, w, h) {
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  w = Math.max(220, Math.min(w, sw));
  h = Math.max(150, Math.min(h, sh));
  // x+w<=sw / y+h<=sh を保証し、窓(と右下リサイズハンドル)が必ずステージ内に収まるようにする。
  x = Math.max(0, Math.min(x, sw - w));
  y = Math.max(0, Math.min(y, sh - h));
  win.el.style.left = x + 'px';
  win.el.style.top = y + 'px';
  win.el.style.width = w + 'px';
  win.el.style.height = h + 'px';
}

function getRect(win) {
  return { x: win.el.offsetLeft, y: win.el.offsetTop, w: win.el.offsetWidth, h: win.el.offsetHeight };
}

// ブラウザ窓のリサイズ時: 最大化窓はステージ全体へ再展開、その他はステージ内へ再クランプ。
function relayoutOnResize() {
  for (const w of wins) {
    if (w.maximized) {
      setRect(w, 4, 4, stage.clientWidth - 8, stage.clientHeight - 8);
    } else {
      const r = getRect(w);
      setRect(w, r.x, r.y, r.w, r.h);
    }
  }
}

function focusWindow(win) {
  // 既にアクティブ(=最前面)なら z を無駄に増やさない。
  // el と bar の二重 mousedown で focusWindow が連続呼出される際の zCounter 膨張も防ぐ。
  if (activeWin === win) return;
  if (activeWin) activeWin.el.classList.remove('active');
  activeWin = win;
  win.el.classList.add('active');
  win.el.style.zIndex = ++zCounter;
}

function makeDraggable(win, handle) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || win.maximized) return;
    // コントロールボタン(ミュート/ソロ/最大化/閉じる)上ではドラッグを開始しない。
    // 開始するとシールドが click を奪い、ボタンが効かなくなるため。
    if (e.target.closest('.win-controls')) return;
    e.preventDefault();
    focusWindow(win);
    const r = getRect(win);
    const sx = e.clientX;
    const sy = e.clientY;
    showShield('move');
    const onMove = (ev) => setRect(win, r.x + (ev.clientX - sx), r.y + (ev.clientY - sy), r.w, r.h);
    const onUp = () => { hideShield(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function makeResizable(win, handle) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || win.maximized) return;
    e.preventDefault();
    e.stopPropagation();
    focusWindow(win);
    const r = getRect(win);
    const sx = e.clientX;
    const sy = e.clientY;
    // リサイズ中は iframe を現在ピクセルで固定し、ドラッグ中の連続リサイズで
    // 埋め込みプレイヤー(Kick 等)が再初期化/404 になるのを防ぐ。
    // 枠(.win)だけ追従させ、iframe の実サイズ変更は mouseup の1回に集約する。
    win.frame.style.width = win.frame.offsetWidth + 'px';
    win.frame.style.height = win.frame.offsetHeight + 'px';
    showShield('nwse-resize');
    const onMove = (ev) => setRect(win, r.x, r.y, r.w + (ev.clientX - sx), r.h + (ev.clientY - sy));
    const onUp = () => {
      hideShield();
      // iframe を CSS の 100% に戻し、最終サイズへ一度だけ追従させる。
      win.frame.style.width = '';
      win.frame.style.height = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function showShield(cursor) { shield.style.cursor = cursor; shield.classList.add('on'); }
function hideShield() { shield.classList.remove('on'); }

function toggleMax(win) {
  if (win.maximized) {
    if (win.prevRect) setRect(win, win.prevRect.x, win.prevRect.y, win.prevRect.w, win.prevRect.h);
    win.maximized = false;
  } else {
    win.prevRect = getRect(win);
    setRect(win, 4, 4, stage.clientWidth - 8, stage.clientHeight - 8);
    win.maximized = true;
    focusWindow(win);
  }
}

// 複数窓をタイル整列(2つメイン+残りサブにしたい時の起点)。
function tileAll() {
  const n = wins.length;
  if (!n) return;
  const gap = 4;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const TARGET = 16 / 9; // 配信は横長動画なので各枠を 16:9 に近づける

  // cols を 1..n で総当たりし、セルのアスペクト比が 16:9 に最も近い分割を選ぶ。
  // これにより縦長ステージでは縦積み(1列)になり、各枠が横長を保つ。
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
  if (!best) {
    const cols = Math.ceil(Math.sqrt(n));
    best = { cols, rows: Math.ceil(n / cols) };
  }

  const { cols, rows } = best;
  const cw = Math.floor((W - gap * (cols + 1)) / cols);
  const ch = Math.floor((H - gap * (rows + 1)) / rows);
  wins.forEach((win, i) => {
    win.maximized = false;
    const c = i % cols;
    const r = Math.floor(i / cols);
    setRect(win, gap + c * (cw + gap), gap + r * (ch + gap), cw, ch);
  });
}

function closeWindow(win) {
  const i = wins.indexOf(win);
  if (i >= 0) wins.splice(i, 1);
  win.el.remove();
  if (activeWin === win) {
    activeWin = null;
    // アクティブ窓を閉じたら、残っている最前面寄りの窓へフォーカスを引き継ぐ。
    if (wins.length) focusWindow(wins[wins.length - 1]);
  }
  updateCount();
  saveLineup();
}

function updateCount() {
  countEl.textContent = wins.length;
  stageEmpty.style.display = wins.length ? 'none' : 'flex';
  document.getElementById('add-btn').disabled = wins.length >= MAX_WINDOWS;
}

// ====== 音声 ======

function toggleMute(win) {
  win.muted = !win.muted;
  sendAudio(win);
  // .solo(可聴が1つだけ)はグローバル状態依存なので、他窓のハイライトも再評価する。
  wins.forEach(updateWinAudioUI);
}

// ソロ: この窓だけ鳴らし、他は全部ミュート(マスタミュートも解除)。
function soloWindow(win) {
  master.muted = false;
  updateMasterMuteUI();
  wins.forEach((w) => { w.muted = w !== win; });
  refreshAllAudio();
}

function setMasterVolume(v) {
  master.volume = v;
  wins.forEach(sendAudio);
}

function toggleMasterMute() {
  master.muted = !master.muted;
  updateMasterMuteUI();
  refreshAllAudio();
}

function updateMasterMuteUI() {
  const btn = document.getElementById('master-mute');
  btn.textContent = '全体ミュート: ' + (master.muted ? 'ON' : 'OFF');
  btn.classList.toggle('on', master.muted);
}

function refreshAllAudio() { wins.forEach(sendAudio); }

function sendAudio(win) {
  const eff = master.muted || win.muted;
  try {
    win.frame.contentWindow.postMessage(
      { [MAGIC]: true, type: 'audio', muted: eff, volume: master.volume },
      '*'
    );
  } catch (e) {
    /* フレーム未ロード等は ready 通知で再送される */
  }
  updateWinAudioUI(win);
}

function updateWinAudioUI(win) {
  // マスタミュート / マスタ音量0 でも実質無音なので、アイコンはミュート表示にする。
  const masterAudible = !master.muted && master.volume > 0;
  const eff = !masterAudible || win.muted;
  win.muteBtn.textContent = eff ? '🔇' : '🔊';
  win.muteBtn.classList.toggle('muted', eff);
  const onlyOneAudible = masterAudible && !win.muted && wins.filter((w) => !w.muted).length === 1;
  win.el.classList.toggle('solo', onlyOneAudible);
}

function onFrameMessage(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true) return;
  if (d.type === 'ready') {
    const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
    if (win) sendAudio(win);
  }
}

// ====== ツールバー ======

function wireToolbar() {
  document.getElementById('master-vol').addEventListener('input', (e) => setMasterVolume(e.target.value / 100));
  document.getElementById('master-mute').addEventListener('click', toggleMasterMute);
  document.getElementById('tile-btn').addEventListener('click', tileAll);

  const addUrl = document.getElementById('add-url');
  const doAdd = () => {
    const u = addUrl.value.trim();
    if (!u || wins.length >= MAX_WINDOWS) return;
    createWindow(u);
    addUrl.value = '';
  };
  document.getElementById('add-btn').addEventListener('click', doAdd);
  addUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

  // 主要サイトのワンクリック追加。
  document.querySelectorAll('.site-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const site = SITES[btn.dataset.site];
      if (site && wins.length < MAX_WINDOWS) createWindow(site.url);
    });
  });

  updateMasterMuteUI();
}

// ====== URL ヘルパ ======

// Kick はフルサイトが iframe 内で 404 になるため公式埋め込みプレイヤーに変換する。
function toEmbedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'kick.com') {
      const channel = u.pathname.split('/').filter(Boolean)[0];
      if (channel) return 'https://player.kick.com/' + encodeURIComponent(channel);
    }
    return rawUrl;
  } catch (e) {
    return rawUrl;
  }
}

function labelFor(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname;
  } catch (e) {
    return url;
  }
}
