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
const countEl = document.getElementById('count');

let zCounter = 10;
let idSeq = 0;
let activeWin = null;
let layoutMode = false;
const master = { volume: 1.0, muted: true };
const wins = [];

(async function init() {
  wireToolbar();
  window.addEventListener('message', onFrameMessage);
  window.addEventListener('resize', relayoutOnResize);

  // 枠の外(ステージ背景)をクリック/タップしたらフォーカス(選択・ヘッダ)を解除する。
  // 枠内クリックは e.target が枠の子要素になるので解除されない。
  stage.addEventListener('pointerdown', (e) => {
    if (e.target === stage || e.target === stageEmpty) clearSelection();
  });

  // iframe(Twitch/YouTube/OpenRec の枠やKickチャット)内のクリックは親に伝わらないので、
  // 「iframe にフォーカスが移った=その枠がクリックされた」を window blur で検知して、
  // その枠を選択しヘッダを一時表示する(タッチでもヘッダを出せるように)。
  window.addEventListener('blur', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      if (!ae || ae.tagName !== 'IFRAME') return;
      const win = wins.find((w) => w.el.contains(ae));
      if (win) { focusWindow(win); revealHeader(win); }
    }, 0);
  });

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

  const isKick = hostOf(url).includes('kick.com');

  const controls = document.createElement('div');
  controls.className = 'win-controls';
  const muteBtn = mkBtn('🔇', 'muted', 'ミュート切替');
  const soloBtn = mkBtn('S', '', 'ソロ(これだけ音を出す)');
  const openBtn = mkBtn('↗', '', '元サイトを新しいタブで開く(ログイン/操作用)');
  const chatBtn = isKick ? mkBtn('💬', 'active', 'チャットの表示/非表示') : null;
  const maxBtn = mkBtn('⛶', '', '最大化/復元');
  const closeBtn = mkBtn('✕', 'close', '閉じる');
  controls.append(muteBtn, soloBtn, openBtn);
  if (chatBtn) controls.append(chatBtn);
  controls.append(maxBtn, closeBtn);
  bar.append(title, controls);

  const body = document.createElement('div');
  body.className = 'win-body';
  let frame = null;
  let video = null;
  if (isKick) {
    // Kick は拡張ページの iframe 内だとプレイヤーの内部リクエスト(IVS)が origin で弾かれ、
    // 最大化など再描画の契機で 404 になる。そこで映像は HLS を <video> で直接再生し
    // (リサイズ/再ペアレントの影響を受けない)、チャットだけ本物の kick.com の popout を
    // 横に並べる(プレイヤーが無いので 404 にならず、拡張ページ配下ならログインも通る想定)。
    body.classList.add('kick-split', 'chat-on');
    const media = document.createElement('div');
    media.className = 'win-media';
    video = document.createElement('video');
    video.className = 'win-video';
    video.autoplay = true;
    video.muted = true; // 自動再生のため(マスタ/ソロで解除)
    video.playsInline = true;
    video.controls = true; // 再生/一時停止・音量・全画面・PiP のネイティブUI
    media.appendChild(video);
    body.appendChild(media);
    setupKickVideo(video, url, media);

    const channel = kickChannelOf(url);
    if (channel) {
      const chat = document.createElement('iframe');
      chat.className = 'win-chat';
      body.appendChild(chat);
      // ログインCookieを埋め込みへ送れるよう緩めてからチャットを読み込む(投稿可能にする)。
      loadFrameWithLogin(chat, 'kick.com', 'https://kick.com/popout/' + encodeURIComponent(channel) + '/chat');
    }
  } else {
    frame = document.createElement('iframe');
    // allow に fullscreen を含むので allowfullscreen 属性は付けない(コンソール警告回避)。
    frame.allow = IFRAME_ALLOW;
    body.appendChild(frame);
    const src = toEmbedUrl(url);
    if (hostOf(url).includes('openrec.tv')) {
      // OpenRec もログインCookieを緩めてから読み込む(iframe 内でログイン状態にする)。
      loadFrameWithLogin(frame, 'openrec.tv', src);
    } else {
      frame.src = src;
    }
    // ※ iframe は生成後 DOM 上で一切 move しないこと。再ペアレントするとブラウザ仕様で
    //   iframe がリロードされ埋め込みが壊れる。最大化/整列/前面化は style 変更のみで行う。
  }

  const resize = document.createElement('div');
  resize.className = 'win-resize';

  // 整形モード用: 中身を覆って枠ごとドラッグ移動するオーバーレイ + 全辺/角のリサイズハンドル。
  const overlay = document.createElement('div');
  overlay.className = 'win-overlay';
  const edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => {
    const h = document.createElement('div');
    h.className = 'win-edge win-edge-' + dir;
    h.dataset.dir = dir;
    return h;
  });

  el.append(bar, body, resize, overlay, ...edges);
  stage.appendChild(el);

  const win = {
    id, url, el, body, frame, video, muteBtn, chatBtn,
    muted: true, maximized: false, prevRect: null, opacity: 100,
    filter: { bright: 100, contrast: 100, sat: 100 }
  };
  wins.push(win);

  const i = wins.length - 1;
  setRect(win, 40 + (i % 6) * 30, 40 + (i % 6) * 30, 520, 320);

  el.addEventListener('pointerdown', () => { focusWindow(win); revealHeader(win); });
  makeDraggable(win, bar);
  makeResizable(win, resize);
  overlay.addEventListener('pointerdown', (e) => beginDrag(win, e));
  edges.forEach((h) => h.addEventListener('pointerdown', (e) => beginResize(win, h.dataset.dir, e)));
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(win); });
  soloBtn.addEventListener('click', (e) => { e.stopPropagation(); soloWindow(win); });
  openBtn.addEventListener('click', (e) => { e.stopPropagation(); openOriginal(win); });
  if (chatBtn) chatBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleChat(win); });
  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(win); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(win); });
  bar.addEventListener('dblclick', () => toggleMax(win));
  if (frame) frame.addEventListener('load', () => sendAudio(win));
  if (video) sendAudio(win);

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

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// ====== Kick: HLS 直再生 ======

// チャンネルの HLS 再生URLを background(SW)経由で取得し、hls.js で video に流す。
function setupKickVideo(video, url, body) {
  const channel = kickChannelOf(url);
  if (!channel) {
    showVideoError(body, 'Kick はチャンネルURL(kick.com/<channel>)を入れてください');
    return;
  }
  chrome.runtime
    .sendMessage({ type: 'get-kick-playback', channel })
    .then((resp) => {
      if (!resp || !resp.ok) {
        const m = resp && resp.error ? resp.error.message || JSON.stringify(resp.error) : '不明';
        showVideoError(body, 'Kick 再生URL取得に失敗: ' + m);
        return;
      }
      playHls(video, resp.playbackUrl, body);
    })
    .catch((e) => showVideoError(body, 'Kick 取得エラー: ' + e.message));
}

function playHls(video, src, body) {
  // Chrome は HLS ネイティブ非対応。Safari 等のため native を一応分岐し、通常は hls.js。
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    video.play().catch(() => {});
    return;
  }
  if (typeof Hls === 'undefined' || !Hls.isSupported()) {
    showVideoError(body, 'この環境は HLS 再生に未対応(hls.js 未読込)');
    return;
  }
  // capLevelToPlayerSize=false: サイズ変化で別品質の再取得をしない(無駄/事故防止)。
  // enableWorker=false: MV3 の CSP(script-src 'self')は blob worker を弾くため、
  // メインスレッド解析にして確実に動かす(配信数本なら負荷は許容)。
  const hls = new Hls({ capLevelToPlayerSize: false, enableWorker: false });
  hls.on(Hls.Events.ERROR, (_evt, data) => {
    if (data && data.fatal) {
      showVideoError(body, 'HLS エラー: ' + data.type + ' / ' + data.details);
    }
  });
  hls.loadSource(src);
  hls.attachMedia(video);
  video.play().catch(() => {});
  video._hls = hls;
}

function kickChannelOf(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0] || '';
  } catch (e) {
    return '';
  }
}

function showVideoError(body, msg) {
  const d = document.createElement('div');
  d.className = 'win-error';
  d.textContent = msg;
  body.appendChild(d);
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
  syncOpacitySlider();
  syncFilterSliders();
}

// 不透明度スライダーを「選択中の枠」の値に合わせる。
function syncOpacitySlider() {
  const s = document.getElementById('opacity-slider');
  if (s && activeWin) s.value = activeWin.opacity != null ? activeWin.opacity : 100;
}

// 枠の主メディア(Kick は <video>、それ以外は iframe)。色調整はここに CSS filter を当てる。
function mediaEl(win) {
  return win.video || win.frame || null;
}

// 明るさ/コントラスト/彩度を CSS filter で適用。cross-origin iframe にも描画結果として効く。
function applyFilter(win) {
  const m = mediaEl(win);
  if (!m) return;
  const f = win.filter || { bright: 100, contrast: 100, sat: 100 };
  m.style.filter =
    'brightness(' + f.bright + '%) contrast(' + f.contrast + '%) saturate(' + f.sat + '%)';
}

// 画質スライダーを「選択中の枠」の値に合わせる。
function syncFilterSliders() {
  if (!activeWin) return;
  const f = activeWin.filter || { bright: 100, contrast: 100, sat: 100 };
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('f-bright', f.bright);
  set('f-contrast', f.contrast);
  set('f-sat', f.sat);
}

// 視聴モードでヘッダを一時的に表示し、数秒後にフェードで消す(クリック/タップ起点)。
function revealHeader(win) {
  if (layoutMode) return; // 整形モードではヘッダは出さない
  win.el.classList.add('show-bar');
  clearTimeout(win.barTimer);
  win.barTimer = setTimeout(() => win.el.classList.remove('show-bar'), 3000);
}

// 選択(アクティブ枠・ヘッダ表示)をすべて解除する。
function clearSelection() {
  if (activeWin) activeWin.el.classList.remove('active');
  activeWin = null;
  wins.forEach((w) => { w.el.classList.remove('show-bar'); clearTimeout(w.barTimer); });
}

function makeDraggable(win, handle) {
  handle.addEventListener('pointerdown', (e) => {
    // コントロールボタン上ではドラッグを開始しない(クリック/タップを奪わないため)。
    if (e.target.closest('.win-controls')) return;
    beginDrag(win, e);
  });
}

function makeResizable(win, handle) {
  handle.addEventListener('pointerdown', (e) => beginResize(win, 'se', e));
}

// マウス/タッチ/ペン共通の Pointer Events で枠を移動する。bar / 整形モードのオーバーレイ
// の両方から呼ばれる。ポインタをキャプチャするので iframe/動画の上をドラッグしても追従する。
function beginDrag(win, e) {
  if (e.button !== 0 || !e.isPrimary || win.maximized) return;
  e.preventDefault();
  focusWindow(win);
  const cap = e.currentTarget;
  const r = getRect(win);
  const sx = e.clientX;
  const sy = e.clientY;
  try { cap.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  const onMove = (ev) => setRect(win, r.x + (ev.clientX - sx), r.y + (ev.clientY - sy), r.w, r.h);
  const onUp = () => {
    cap.removeEventListener('pointermove', onMove);
    cap.removeEventListener('pointerup', onUp);
    cap.removeEventListener('pointercancel', onUp);
  };
  cap.addEventListener('pointermove', onMove);
  cap.addEventListener('pointerup', onUp);
  cap.addEventListener('pointercancel', onUp);
}

// dir は 'n','s','e','w' とその組合せ('se' 等)。指定した辺/角からリサイズする。
function beginResize(win, dir, e) {
  if (e.button !== 0 || !e.isPrimary || win.maximized) return;
  e.preventDefault();
  e.stopPropagation();
  focusWindow(win);
  const cap = e.currentTarget;
  const r = getRect(win);
  const sx = e.clientX;
  const sy = e.clientY;
  try { cap.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  const onMove = (ev) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    let x = r.x;
    let y = r.y;
    let w = r.w;
    let h = r.h;
    if (dir.includes('e')) w = Math.max(220, r.w + dx);
    if (dir.includes('s')) h = Math.max(150, r.h + dy);
    if (dir.includes('w')) { w = Math.max(220, r.w - dx); x = r.x + r.w - w; } // 右辺を固定
    if (dir.includes('n')) { h = Math.max(150, r.h - dy); y = r.y + r.h - h; } // 下辺を固定
    setRect(win, x, y, w, h);
  };
  const onUp = () => {
    cap.removeEventListener('pointermove', onMove);
    cap.removeEventListener('pointerup', onUp);
    cap.removeEventListener('pointercancel', onUp);
  };
  cap.addEventListener('pointermove', onMove);
  cap.addEventListener('pointerup', onUp);
  cap.addEventListener('pointercancel', onUp);
}

function cursorForDir(dir) {
  if (dir === 'n' || dir === 's') return 'ns-resize';
  if (dir === 'e' || dir === 'w') return 'ew-resize';
  if (dir === 'ne' || dir === 'sw') return 'nesw-resize';
  return 'nwse-resize'; // nw, se
}

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

// ログインCookie(SameSite)を埋め込みフレームへ送れるよう background で緩めてから
// src を読み込む。これでフレーム内でログイン状態になり、チャット投稿などができる。
function loadFrameWithLogin(frameEl, domain, src) {
  chrome.runtime
    .sendMessage({ type: 'relax-cookies', domains: [domain] })
    .then(() => { frameEl.src = src; })
    .catch(() => { frameEl.src = src; }); // 失敗しても一応読み込む
}

// Kick 枠のチャット表示/非表示を切り替える。
function toggleChat(win) {
  if (!win.body) return;
  const on = win.body.classList.toggle('chat-on');
  if (win.chatBtn) win.chatBtn.classList.toggle('active', on);
}

// 元サイトを新しいタブで開く。フル機能を本物のサイトで使いたい時の導線。
function openOriginal(win) {
  try {
    chrome.tabs.create({ url: win.url });
  } catch (e) {
    window.open(win.url, '_blank', 'noopener');
  }
}

function closeWindow(win) {
  const i = wins.indexOf(win);
  if (i >= 0) wins.splice(i, 1);
  if (win.video && win.video._hls) {
    try { win.video._hls.destroy(); } catch (e) { /* noop */ }
  }
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
  if (win.video) {
    // 自前の <video>(Kick)は直接制御する。
    try {
      win.video.muted = eff;
      if (!eff) win.video.volume = master.volume;
    } catch (e) {
      /* noop */
    }
  } else if (win.frame) {
    try {
      win.frame.contentWindow.postMessage(
        { [MAGIC]: true, type: 'audio', muted: eff, volume: master.volume },
        '*'
      );
    } catch (e) {
      /* フレーム未ロード等は ready 通知で再送される */
    }
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
  document.getElementById('layout-btn').addEventListener('click', toggleLayoutMode);
  document.getElementById('opacity-slider').addEventListener('input', (e) => {
    if (!activeWin) return;
    const v = Number(e.target.value);
    activeWin.opacity = v;
    activeWin.el.style.opacity = v / 100;
    revealHeader(activeWin); // 調整中はどの枠が対象か分かるよう再表示
  });

  // 画質(明るさ/コントラスト/彩度)を選択中の枠に適用。
  const bindFilter = (id, key) => {
    document.getElementById(id).addEventListener('input', (e) => {
      if (!activeWin) return;
      activeWin.filter[key] = Number(e.target.value);
      applyFilter(activeWin);
      revealHeader(activeWin);
    });
  };
  bindFilter('f-bright', 'bright');
  bindFilter('f-contrast', 'contrast');
  bindFilter('f-sat', 'sat');
  document.getElementById('f-reset').addEventListener('click', () => {
    if (!activeWin) return;
    activeWin.filter = { bright: 100, contrast: 100, sat: 100 };
    applyFilter(activeWin);
    syncFilterSliders();
    revealHeader(activeWin);
  });

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

// 整形モード: ON の間は各枠の中身をオーバーレイで覆い、枠ごとの移動・全辺リサイズに
// 専念できる(中身=動画/チャットには触れない)。OFF で通常操作に戻る。
function toggleLayoutMode() {
  layoutMode = !layoutMode;
  stage.classList.toggle('layout-mode', layoutMode);
  document.getElementById('layout-btn').classList.toggle('on', layoutMode);
  if (!layoutMode) clearSelection(); // 視聴モードに戻ったら選択(ヘッダ/青枠)を解除
}

// ====== URL ヘルパ ======

// iframe で開くサイトの src 変換用(現状は変換不要。Kick は iframe を使わず video 直再生に
// 分岐済み)。将来サイト別の埋め込みURL変換が要るときの拡張ポイント。
function toEmbedUrl(rawUrl) {
  return rawUrl;
}

function labelFor(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname;
  } catch (e) {
    return url;
  }
}
