// マルチビュー本体ページの「ページ内ウィンドウマネージャ」。
// storage(MULTIVIEW_ACTIVE_KEY)の URL 群を読み、各配信を iframe のフローティング窓として
// ステージ上に並べる。ドラッグ移動・右下リサイズ・重ね(z-order)・最大化・整列に対応。
// 音声はクロスオリジンで直接触れないため、各フレームの content script(stream-control.js)へ
// postMessage で muted/volume を指示する。起動時は全ミュート、各窓の S(ソロ)で1つだけ鳴らす。

const MULTIVIEW_ACTIVE_KEY = 'multiviewActive';
const AD_SKIP_KEY = 'adSkipEnabled'; // 広告スキップのオン/オフ。各枠の stream-control.js が storage で追従する。
const MAX_WINDOWS = 20;
const MIN_W = 420; // 枠の最小幅(これ未満には縮められない。台形のボタン列が収まる幅)
const MIN_H = 220; // 枠の最小高さ(小さすぎると視聴の意味がないので下限を設ける)
const IDLE_HIDE_MS = 3000; // この時間ポインタが動かないとカーソル+ツールバーを自動で隠す(復帰は ≡メニュー)
const TOOLBAR_POS_KEY = 'toolbarPos'; // ツールバーの配置(top/bottom/left/right)を保存する storage キー
const TOOLBAR_POSITIONS = ['top', 'bottom', 'left', 'right'];
const PERF_HISTORY = 60; // パフォーマンスパネルのスパークラインに保持するサンプル数(≒直近60秒)
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
let masterVolume = 0; // 全体音量(0〜1)。0=無音。各枠の音量をまとめて設定する。
let restoring = true; // 復元中は saveLineup を抑止(復元の途中経過で保存データを部分上書きしないため)
const wins = [];

(async function init() {
  wireToolbar();
  setupIdleHide();
  window.addEventListener('resize', relayoutOnResize);
  window.addEventListener('message', onFrameUrl);
  window.addEventListener('message', onFrameAdState);

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

  const data = await chrome.storage.local.get(MULTIVIEW_ACTIVE_KEY);
  const saved = data[MULTIVIEW_ACTIVE_KEY] || {};

  // マスタ音量を復元(無ければ 0)。窓を作る前に入れておき、各枠が最初からこの音量で開くように。
  masterVolume = clampVol(saved.masterVolume);
  syncMasterUI();

  // 新フォーマット(wins: 位置・サイズ付き)を優先して位置ごと復元。旧フォーマット(urls のみ)は
  // 初回だけ整列にフォールバック。以後は移動・リサイズのたびに保存されるので勝手に整列し直さない。
  if (Array.isArray(saved.wins) && saved.wins.length) {
    saved.wins.slice(0, MAX_WINDOWS).forEach((it) => {
      const url = (it.url || '').trim();
      if (!url) return;
      const win = createWindow(url, { silent: true });
      if (win) {
        if (Number.isFinite(it.vol)) {
          win.vol = it.vol;
          if (win.volSlider) win.volSlider.value = String(Math.round(it.vol * 100));
          applyVolume(win, masterVolume);
        }
        if (Number.isFinite(it.x)) {
          setRect(win, it.x, it.y, it.w, it.h);
          if (it.max) toggleMax(win);
        }
        if (it.hidden) hideWindow(win); // 隠した状態も復元(位置・サイズは保持)
      }
    });
  } else {
    const urls = (saved.urls || []).map((u) => (u || '').trim()).filter((u) => u.length > 0).slice(0, MAX_WINDOWS);
    urls.forEach((u) => createWindow(u, { silent: true }));
    if (urls.length) tileAll(); // 旧データの初回だけ整列(以後は位置を保存・復元)
  }
  restoring = false; // 以後の移動/リサイズ/追加/削除は保存する
  updateCount();
})();

// content script(stream-control.js)から「この枠が今開いている URL」を受け取り、
// 枠内で別の配信ページへ移動したら、その URL を保存して次回復元できるようにする。
function onFrameUrl(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true || d.type !== 'frame-url' || !d.href) return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win || win.url === d.href) return;
  win.url = d.href;
  if (win.titleEl) win.titleEl.textContent = labelFor(d.href);
  saveLineup();
  renderMixer(); // 一覧のラベルも更新
}

// content script(stream-control.js)から広告検知の状態を受け取り、その枠に
// 「広告スキップ中」表示(.ad-skipping)を出す/消す。広告スキップ ON のときだけ通知が来る。
function onFrameAdState(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true || d.type !== 'ad-state') return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (win) win.el.classList.toggle('ad-skipping', !!d.adSkipping);
}

// 現在の配信ラインナップ(URL+位置・サイズ+最大化)とマスタ音量を storage に保存。
// 専用ページを開き直すと、この内容で復元される(勝手に整列し直さない)。復元中は呼ばれても抑止。
function saveLineup() {
  if (restoring) return;
  const items = wins.map((w) => {
    const r = w.maximized && w.prevRect ? w.prevRect : getRect(w);
    return {
      url: w.url,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
      max: !!w.maximized, vol: w.vol != null ? w.vol : 1, hidden: !!w.hidden
    };
  });
  try {
    chrome.storage.local.set({
      [MULTIVIEW_ACTIVE_KEY]: { wins: items, masterVolume, timestamp: new Date().toISOString() }
    });
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
  // 左端のグリップ=ヘッダの左右スライド専用、中央(barMain)=つかむと枠移動。つまむ位置で挙動を分ける。
  const gripL = document.createElement('div');
  gripL.className = 'win-grip';
  gripL.textContent = '⋮';
  gripL.title = 'ドラッグでヘッダを左右にスライド';
  const barMain = document.createElement('div');
  barMain.className = 'win-bar-main';
  const title = document.createElement('div');
  title.className = 'win-title';
  title.textContent = labelFor(url);
  // 枠ごとの音量バーを台形ハンドルに直接置く(実音量 = この値 × マスタ)。狭い枠では CSS で隠す。
  const volWrap = document.createElement('div');
  volWrap.className = 'win-vol';
  const volIcon = document.createElement('span');
  volIcon.className = 'win-vol-icon';
  volIcon.textContent = '🔊';
  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = '100';
  volSlider.title = 'この枠の音量';
  volWrap.append(volIcon, volSlider);

  const isKick = hostOf(url).includes('kick.com');

  const controls = document.createElement('div');
  controls.className = 'win-controls';
  // 音声は各プレイヤー自前のミュート/音量で操作する方針(起動時のみ全ミュート)。
  // よって枠ヘッダにミュート/ソロボタンは置かない。
  const openBtn = mkBtn('↗', '', '元サイトを新しいタブで開く(ログイン/操作用)');
  const reloadBtn = mkBtn('🔄', '', 'この枠を再読込');
  const chatBtn = isKick ? mkBtn('💬', 'active', 'チャットの表示/非表示') : null;
  const adjustBtn = mkBtn('🎨', '', 'この枠の透明度・画質を調整');
  const maxBtn = mkBtn('⛶', '', '最大化/復元');
  const closeBtn = mkBtn('✕', 'close', '閉じる');
  controls.append(openBtn, reloadBtn);
  if (chatBtn) controls.append(chatBtn);
  controls.append(adjustBtn, maxBtn, closeBtn);
  // [グリップ左][ タイトル + 音量 + ボタン = 枠移動ゾーン ] の順で台形ハンドルを組む。
  barMain.append(title, volWrap, controls);
  bar.append(gripL, barMain);

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
    video.muted = true; // 起動時はミュート(轟音防止)。以後はネイティブUIで自分で解除
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
    // iframe は win 確定後に mountSiteFrame() で生成する。
    // ※ iframe は生成後 DOM 上で move しないこと(再ペアレントすると埋め込みが壊れる)。
  }

  // 全辺/角のリサイズハンドル(常時有効。当たり判定はオンマウス時だけ・グリップもその時だけ表示)。
  // 枠の overflow:hidden で切れないよう内側に置く。
  const edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => {
    const h = document.createElement('div');
    h.className = 'win-edge win-edge-' + dir;
    h.dataset.dir = dir;
    return h;
  });

  el.append(bar, body, ...edges);
  stage.appendChild(el);

  const win = {
    id, url, el, body, frame, video, chatBtn, bar, barX: 0, titleEl: title, volSlider,
    maximized: false, hidden: false, prevRect: null, opacity: 100, vol: 1,
    filter: { bright: 100, contrast: 100, sat: 100 }
  };
  wins.push(win);

  const i = wins.length - 1;
  setRect(win, 40 + (i % 6) * 30, 40 + (i % 6) * 30, 520, 320);

  el.appendChild(buildAdjustPanel(win));

  el.addEventListener('pointerdown', () => { focusWindow(win); revealHeader(win); });
  makeBarHandle(win, bar);
  edges.forEach((h) => h.addEventListener('pointerdown', (e) => beginResize(win, h.dataset.dir, e)));
  // 台形内の音量バー: 操作しても枠は動かさない(makeBarHandle が .win-vol を除外)。即反映+離したら保存。
  volSlider.value = String(Math.round((win.vol != null ? win.vol : 1) * 100));
  volSlider.addEventListener('input', () => {
    setWinVol(win, Number(volSlider.value) / 100); // 台形/ミキサー両方のスライダーを同期
    volIcon.textContent = win.vol <= 0 ? '🔇' : '🔊';
    revealHeader(win); // 操作中はヘッダを消さない(特にタッチ)
  });
  volSlider.addEventListener('change', () => saveLineup());
  openBtn.addEventListener('click', (e) => { e.stopPropagation(); openOriginal(win); });
  reloadBtn.addEventListener('click', (e) => { e.stopPropagation(); reloadWindow(win); });
  if (chatBtn) chatBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleChat(win); });
  adjustBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleAdjust(win); });
  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(win); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(win); });
  bar.addEventListener('dblclick', () => toggleMax(win));
  // サイト枠(非Kick)の iframe を生成。Kick は <video> なので applyVolume だけ。
  if (!isKick) mountSiteFrame(win);
  applyVolume(win, masterVolume);

  focusWindow(win);
  if (!opts.silent) {
    updateCount();
    saveLineup();
    renderMixer();
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
  w = Math.max(MIN_W, Math.min(w, sw));
  h = Math.max(MIN_H, Math.min(h, sh));
  // x+w<=sw / y+h<=sh を保証し、窓(と右下リサイズハンドル)が必ずステージ内に収まるようにする。
  x = Math.max(0, Math.min(x, sw - w));
  y = Math.max(0, Math.min(y, sh - h));
  win.el.style.left = x + 'px';
  win.el.style.top = y + 'px';
  win.el.style.width = w + 'px';
  win.el.style.height = h + 'px';
  updateWinWidthClass(win, w);
  clampBarX(win);
}

// 枠幅に応じて台形の中身を出し分けるクラスを付ける(旧 container-query の置き換え)。
// w を直接見るのでレイアウト読み取り(reflow)を起こさない。閾値は旧 @container と同じ。
function updateWinWidthClass(win, w) {
  win.el.classList.toggle('cq-hide-title', w < 600);
  win.el.classList.toggle('cq-hide-vol', w < 500);
}

// 台形ハンドルのスライド量を現在の枠幅で再クランプ(リサイズ/最大化で枠からはみ出さないように)。
function clampBarX(win) {
  if (!win || !win.bar) return;
  const maxOff = Math.max(0, (win.el.clientWidth - win.bar.offsetWidth) / 2);
  const x = Math.max(-maxOff, Math.min(maxOff, win.barX || 0));
  win.barX = x;
  win.el.style.setProperty('--bar-x', x + 'px');
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

// 各枠ヘッダの 🎨 から開く「この枠だけ」の調整パネル(透明度・明るさ・コントラスト・彩度)。
function buildAdjustPanel(win) {
  const panel = document.createElement('div');
  panel.className = 'win-adjust';

  const mkRow = (label, min, max, value, oninput) => {
    const row = document.createElement('label');
    row.className = 'adj-row';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('input', () => oninput(Number(input.value)));
    row.append(span, input);
    return { row, input };
  };

  const rOpacity = mkRow('透明', 20, 100, win.opacity, (v) => {
    win.opacity = v;
    win.el.style.opacity = v / 100;
  });
  const rBright = mkRow('☀ 明るさ', 20, 200, win.filter.bright, (v) => {
    win.filter.bright = v;
    applyFilter(win);
  });
  const rContrast = mkRow('◐ コントラスト', 20, 200, win.filter.contrast, (v) => {
    win.filter.contrast = v;
    applyFilter(win);
  });
  const rSat = mkRow('🎨 彩度', 0, 200, win.filter.sat, (v) => {
    win.filter.sat = v;
    applyFilter(win);
  });

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'adj-reset';
  reset.textContent = 'リセット';
  reset.addEventListener('click', (e) => {
    e.stopPropagation();
    win.opacity = 100;
    win.el.style.opacity = '';
    win.filter = { bright: 100, contrast: 100, sat: 100 };
    applyFilter(win);
    rOpacity.input.value = '100';
    rBright.input.value = '100';
    rContrast.input.value = '100';
    rSat.input.value = '100';
  });

  panel.append(rOpacity.row, rBright.row, rContrast.row, rSat.row, reset);
  return panel;
}

// 🎨 パネルの開閉(同時に1枠だけ開く)。
function toggleAdjust(win) {
  const willOpen = !win.el.classList.contains('adjust-open');
  wins.forEach((w) => w.el.classList.remove('adjust-open'));
  if (willOpen) win.el.classList.add('adjust-open');
}

// 視聴モードでヘッダを一時的に表示し、数秒後にフェードで消す(クリック/タップ起点)。
function revealHeader(win) {
  win.el.classList.add('show-bar');
  clearTimeout(win.barTimer);
  win.barTimer = setTimeout(() => win.el.classList.remove('show-bar'), 3000);
}

// 選択(アクティブ枠・ヘッダ表示)をすべて解除する。
function clearSelection() {
  if (activeWin) activeWin.el.classList.remove('active');
  activeWin = null;
  wins.forEach((w) => { w.el.classList.remove('show-bar', 'adjust-open'); clearTimeout(w.barTimer); });
}

// 台形ハンドル: つまむ位置で挙動を分ける(RDP風)。
//  - 両端のグリップ(.win-grip): ヘッダを枠の上辺に沿って左右にスライド(両端で止まる)。
//  - 中央の本体(.win-bar-main): つかむと枠を移動。
// ポインタをキャプチャするので iframe/動画の上をドラッグしても追従する。ボタン上では発火しない。
function makeBarHandle(win, bar) {
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary || win.maximized) return;
    if (e.target.closest('.win-controls, .win-vol')) return; // ボタン/音量バー上は掴まない
    const slideMode = !!e.target.closest('.win-grip'); // 左グリップ=スライド / それ以外=枠移動
    e.preventDefault();
    focusWindow(win);
    const sx = e.clientX;
    const sy = e.clientY;
    const startBarX = win.barX || 0;
    const r = getRect(win);
    const maxOff = Math.max(0, (win.el.clientWidth - bar.offsetWidth) / 2);
    bar.classList.add('sliding');
    try { bar.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    const onMove = (ev) => {
      if (slideMode) {
        const x = Math.max(-maxOff, Math.min(maxOff, startBarX + (ev.clientX - sx)));
        win.barX = x;
        win.el.style.setProperty('--bar-x', x + 'px');
      } else {
        setRect(win, r.x + (ev.clientX - sx), r.y + (ev.clientY - sy), r.w, r.h);
      }
    };
    const end = () => {
      bar.classList.remove('sliding');
      try { bar.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
      if (!slideMode) saveLineup(); // 枠を動かしたら位置を保存(スライドのみのときは保存しない)
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  });
}

// dir は 'n','s','e','w' とその組合せ('se' 等)。指定した辺/角からリサイズする。
function beginResize(win, dir, e) {
  if (e.button !== 0 || !e.isPrimary || win.maximized) return;
  e.preventDefault();
  e.stopPropagation();
  focusWindow(win);
  revealHeader(win); // リサイズ中もヘッダ/隅マークを出し続ける(特にタッチで掴みやすく)
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
    if (dir.includes('e')) w = Math.max(MIN_W, r.w + dx);
    if (dir.includes('s')) h = Math.max(MIN_H, r.h + dy);
    if (dir.includes('w')) { w = Math.max(MIN_W, r.w - dx); x = r.x + r.w - w; } // 右辺を固定
    if (dir.includes('n')) { h = Math.max(MIN_H, r.h - dy); y = r.y + r.h - h; } // 下辺を固定
    setRect(win, x, y, w, h);
  };
  const onUp = () => {
    cap.removeEventListener('pointermove', onMove);
    cap.removeEventListener('pointerup', onUp);
    cap.removeEventListener('pointercancel', onUp);
    saveLineup(); // リサイズ後のサイズ・位置を保存
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
  saveLineup(); // 最大化/復元の状態を保存(復元中は抑止)
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
  saveLineup(); // 整列後の配置を保存(復元中の初回フォールバックでは restoring で抑止)
}

// ログインCookie(SameSite)を埋め込みフレームへ送れるよう background で緩めてから
// src を読み込む。これでフレーム内でログイン状態になり、チャット投稿などができる。
function loadFrameWithLogin(frameEl, domain, src) {
  chrome.runtime
    .sendMessage({ type: 'relax-cookies', domains: [domain] })
    .then(() => { frameEl.src = src; })
    .catch(() => { frameEl.src = src; }); // 失敗しても一応読み込む
}

// 埋め込み内でログインを使いたいサイトの cookie 緩和対象ドメインを返す(対象外は null)。
// YouTube は埋め込みログインの仕組みが別で、緩和がむしろ逆効果になりうるため対象にしない。
function loginDomainOf(host) {
  if (host.includes('twitch.tv')) return 'twitch.tv';
  if (host.includes('openrec.tv')) return 'openrec.tv';
  return null;
}

// Kick 枠のチャット表示/非表示を切り替える。
function toggleChat(win) {
  if (!win.body) return;
  const on = win.body.classList.toggle('chat-on');
  if (win.chatBtn) win.chatBtn.classList.toggle('active', on);
}

// サイト枠(Twitch/YouTube/OPENREC)の iframe を生成して body に載せる。
function mountSiteFrame(win) {
  const frame = document.createElement('iframe');
  frame.allow = IFRAME_ALLOW;
  win.body.appendChild(frame);
  win.frame = frame;
  frame.addEventListener('load', () => applyVolume(win, masterVolume));
  const src = toEmbedUrl(win.url);
  // ログインCookieを埋め込みへ通す(SameSite緩和)。対象サイトのみ。
  const loginDomain = loginDomainOf(hostOf(win.url));
  if (loginDomain) {
    loadFrameWithLogin(frame, loginDomain, src);
  } else {
    frame.src = src;
  }
  applyVolume(win, masterVolume);
}

// 枠をその場で再読込する(🔄)。iframe は作り直し、Kick は HLS を貼り直す。
function reloadWindow(win) {
  if (win.frame) {
    win.frame.remove();
    mountSiteFrame(win); // 現在の win.url で iframe を作り直す
  } else if (win.video) {
    const media = win.video.parentElement;
    if (win.video._hls) { try { win.video._hls.destroy(); } catch (e) { /* noop */ } win.video._hls = null; }
    if (media) media.querySelectorAll('.win-error').forEach((el) => el.remove());
    setupKickVideo(win.video, win.url, media);
  }
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
  renderMixer();
}

function updateCount() {
  countEl.textContent = wins.length;
  stageEmpty.style.display = wins.length ? 'none' : 'flex';
  document.getElementById('add-btn').disabled = wins.length >= MAX_WINDOWS;
}

// ====== 音声 ======
// 方針: 起動時のみ全ミュート(轟音防止)。マスタ音量つまみで全枠まとめて音量を設定できる。
// クロスオリジン埋め込みはタブ出力音を直接絞れないため、各枠の音量をまとめて設定する形。
// つまみ操作時にだけ適用(継続的な上書きはしない)ので、以後は各プレイヤーで個別調整も可能。

function setMasterVolume(v) {
  masterVolume = v;
  for (const win of wins) applyVolume(win, v);
}

function clampVol(v) {
  v = Number(v);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

// マスタ音量つまみ/アイコンを masterVolume に同期させる(ツールバー + ミキサーの両方)。
function syncMasterUI() {
  const v = Math.round(masterVolume * 100);
  const icon = masterVolume <= 0 ? '🔇' : '🔊';
  const s1 = document.getElementById('master-vol'); if (s1) s1.value = v;
  const i1 = document.getElementById('master-vol-icon'); if (i1) i1.textContent = icon;
  const s2 = document.getElementById('mixer-master'); if (s2) s2.value = v;
  const i2 = document.getElementById('mixer-master-icon'); if (i2) i2.textContent = icon;
}

// 音量のみ設定する(ミュートは触らない=各プレイヤー自前のミュートで「1つだけ聞く」が可能)。
// マスタ0 のときは volume=0 で実質無音。
// 音量を枠へ反映。実音量 = 枠ごと音量(win.vol) × マスタ(v)。枠ごと音量は 🎨 パネルで設定する。
// マスタを動かすと全枠が同倍率で増減 → 枠ごとの大小関係(win.vol の比)は保たれる。
// 確実に効く video.volume を当てる(Kick の <video> はここ=親で、iframe 内は content script 経由で)。
function applyVolume(win, v) {
  const eff = win.hidden ? 0 : Math.max(0, Math.min(1, (win.vol != null ? win.vol : 1) * v));
  if (win.video) {
    try { win.video.volume = eff; } catch (e) { /* noop */ }
  } else if (win.frame) {
    try {
      win.frame.contentWindow.postMessage({ [MAGIC]: true, type: 'set-volume', value: eff }, '*');
    } catch (e) { /* noop */ }
  }
}

// ====== 枠一覧 / ミキサーパネル ======

// 枠ごとの音量を設定し、台形ハンドルとミキサー両方のスライダー表示を同期させる。
function setWinVol(win, v01) {
  win.vol = Math.max(0, Math.min(1, v01));
  applyVolume(win, masterVolume);
  syncVolUI(win);
}
function syncVolUI(win) {
  const v = String(Math.round((win.vol != null ? win.vol : 1) * 100));
  if (win.volSlider) win.volSlider.value = v;
  const row = document.querySelector('#mixer-panel .mixer-row[data-id="' + win.id + '"] .mixer-row-vol');
  if (row) row.value = v;
}

// 枠を「隠す/表示する」。隠しても位置・サイズ・URLは保持。実音量を0にして音も消す(=一旦閉じる)。
function hideWindow(win) {
  win.hidden = true;
  win.el.style.display = 'none';
  applyVolume(win, masterVolume); // hidden → 実音量0
  renderMixer();
  saveLineup();
}
function showWindow(win) {
  win.hidden = false;
  win.el.style.display = '';
  applyVolume(win, masterVolume);
  focusWindow(win); // 出したら最前面へ
  renderMixer();
  saveLineup();
}
function toggleHidden(win) { win.hidden ? showWindow(win) : hideWindow(win); }

// 枠一覧(ミキサー)を再描画。パネルが閉じている間は何もしない。
function renderMixer() {
  const panel = document.getElementById('mixer-panel');
  if (!panel || panel.hidden) return;
  const list = panel.querySelector('.mixer-list');
  list.innerHTML = '';
  if (!wins.length) {
    const empty = document.createElement('div');
    empty.className = 'mixer-empty';
    empty.textContent = '枠がありません';
    list.appendChild(empty);
    return;
  }
  wins.forEach((win) => {
    const row = document.createElement('div');
    row.className = 'mixer-row' + (win.hidden ? ' is-hidden' : '');
    row.dataset.id = win.id;

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'mixer-row-label';
    label.textContent = labelFor(win.url);
    label.title = 'クリックで最前面に表示';
    label.addEventListener('click', () => { if (win.hidden) showWindow(win); else focusWindow(win); });

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'mixer-row-eye';
    eye.textContent = win.hidden ? '🙈' : '👁';
    eye.title = win.hidden ? '表示する' : '隠す(位置・サイズは保持・音も消す)';
    eye.addEventListener('click', () => toggleHidden(win));

    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '100';
    vol.value = String(Math.round((win.vol != null ? win.vol : 1) * 100));
    vol.className = 'mixer-row-vol';
    vol.title = 'この枠の音量';
    vol.addEventListener('input', () => setWinVol(win, Number(vol.value) / 100));
    vol.addEventListener('change', () => saveLineup());

    row.append(label, eye, vol);
    list.appendChild(row);
  });
}

// ミキサーパネルの配線(トグル/閉じる/マスタ/ドラッグ/リサイズ)。
function setupMixer() {
  const panel = document.getElementById('mixer-panel');
  makePanelDraggable(panel, panel.querySelector('.mixer-head'));
  const rz = panel.querySelector('.mixer-resize');
  if (rz) makePanelResizable(panel, rz);
  document.getElementById('mixer-close').addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('mixer-btn').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { syncMasterUI(); renderMixer(); }
  });
  const mm = document.getElementById('mixer-master');
  mm.addEventListener('input', () => { setMasterVolume(Number(mm.value) / 100); syncMasterUI(); });
  mm.addEventListener('change', () => saveLineup());
}

// 汎用: ハンドルをつかんで要素を移動(ステージ内にクランプ)。ミキサーパネル用。
function makePanelDraggable(el, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (e.target.closest('button, input')) return; // ボタン/つまみ上は移動しない
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const sl = el.offsetLeft, st = el.offsetTop;
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    const onMove = (ev) => {
      const maxL = Math.max(0, stage.clientWidth - 60);
      const maxT = Math.max(0, stage.clientHeight - 40);
      el.style.left = Math.max(0, Math.min(maxL, sl + ev.clientX - sx)) + 'px';
      el.style.top = Math.max(0, Math.min(maxT, st + ev.clientY - sy)) + 'px';
    };
    const end = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

// 汎用: 右下ハンドルで要素をリサイズ。ミキサーパネル用。
function makePanelResizable(el, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const sw = el.offsetWidth, sh = el.offsetHeight;
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    const onMove = (ev) => {
      el.style.width = Math.max(240, sw + ev.clientX - sx) + 'px';
      el.style.height = Math.max(160, sh + ev.clientY - sy) + 'px';
    };
    const end = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

// ====== ツールバー ======

function wireToolbar() {
  const masterSlider = document.getElementById('master-vol');
  masterSlider.addEventListener('input', (e) => {
    setMasterVolume(Number(e.target.value) / 100);
    syncMasterUI(); // ツールバー+ミキサーのアイコン/つまみを同期
  });
  // つまみを離した時に保存(input 連発で storage を叩かないよう change で一度だけ)。
  masterSlider.addEventListener('change', () => saveLineup());
  document.getElementById('tile-btn').addEventListener('click', tileAll);

  // 広告スキップのオン/オフ(YouTube枠が対象)。ここは状態を storage に保存するだけで、実際の
  // 検知・スキップは各枠の content script(stream-control.js)が storage を見て行う。既定はオフ。
  const adskipBtn = document.getElementById('adskip-btn');
  chrome.storage.local.get(AD_SKIP_KEY, (d) => adskipBtn.classList.toggle('adskip-on', d[AD_SKIP_KEY] === true));
  adskipBtn.addEventListener('click', () => {
    const enabled = !adskipBtn.classList.contains('adskip-on');
    adskipBtn.classList.toggle('adskip-on', enabled);
    chrome.storage.local.set({ [AD_SKIP_KEY]: enabled });
  });
  // 透明度・画質は枠ごとの設定なので、各枠ヘッダの 🎨 から開く調整パネルに置く
  // (ツールバーに置くと音量のようなマスタ設定に見えてしまうため)。
  document.getElementById('toolbar-toggle').addEventListener('click', () => document.body.classList.add('toolbar-hidden'));
  document.getElementById('toolbar-show').addEventListener('click', () => document.body.classList.remove('toolbar-hidden'));

  // 「＋追加」→ 追加ダイアログ(サイトボタン / URL入力)。ツールバーをすっきりさせるため別モーダルに。
  const addDialog = document.getElementById('add-dialog');
  const closeAdd = () => addDialog.classList.remove('open');
  document.getElementById('add-open-btn').addEventListener('click', (e) => { e.stopPropagation(); addDialog.classList.add('open'); });
  document.getElementById('add-dialog-close').addEventListener('click', closeAdd);
  addDialog.addEventListener('click', (e) => { if (e.target === addDialog) closeAdd(); }); // 外側クリックで閉じる

  const addUrl = document.getElementById('add-url');
  const doAdd = () => {
    const u = addUrl.value.trim();
    if (!u || wins.length >= MAX_WINDOWS) return;
    createWindow(u);
    addUrl.value = '';
    closeAdd();
  };
  document.getElementById('add-btn').addEventListener('click', doAdd);
  addUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

  // ダイアログ内: 主要サイトのワンクリック追加(追加したらダイアログを閉じる)。
  document.querySelectorAll('.site-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const site = SITES[btn.dataset.site];
      if (site && wins.length < MAX_WINDOWS) createWindow(site.url);
      closeAdd();
    });
  });

  // メニュー位置: ダイアログ配線 + 保存値の復元(初回はアニメさせないため tb-ready を遅延付与)。
  setupPosDialog();
  setupPerfPanel();
  setupMixer();
  chrome.storage.local.get(TOOLBAR_POS_KEY, (d) => {
    applyToolbarPos((d && d[TOOLBAR_POS_KEY]) || 'bottom', false);
    requestAnimationFrame(() => document.body.classList.add('tb-ready'));
  });
}

// マウスを一定時間動かさなかったら、カーソルを消してツールバーを隠す(視聴に集中できるように)。
// 復帰は ≡メニュー(#toolbar-show)から。マウスを動かした時はカーソルだけ戻し、ツールバーは出さない
// (= 明示的にボタンを押した時だけ出す)。タッチ(pointer)でも同様に働く。
function setupIdleHide() {
  const toolbar = document.getElementById('toolbar');
  let idleTimer = null;
  const goIdle = () => {
    // ツールバー上にポインタがある(操作中)なら隠さない。離れて静止すれば次の動きで再武装され隠れる。
    if (toolbar.matches(':hover')) return;
    document.body.classList.add('idle', 'toolbar-hidden');
  };
  const arm = () => {
    document.body.classList.remove('idle'); // カーソルを戻す(toolbar-hidden は触らない)
    clearTimeout(idleTimer);
    idleTimer = setTimeout(goIdle, IDLE_HIDE_MS);
  };
  ['pointermove', 'pointerdown'].forEach((ev) => document.addEventListener(ev, arm, { passive: true }));
  arm();
}

// ツールバーの配置(上/下/左/右)を適用。body のクラスで CSS が位置とレイアウト(横/縦バー)を切替える。
// save=false は起動時の復元用(storage へ書き戻さない)。
function applyToolbarPos(pos, save = true) {
  if (!TOOLBAR_POSITIONS.includes(pos)) pos = 'top';
  const vertical = pos === 'left' || pos === 'right';
  TOOLBAR_POSITIONS.forEach((p) => document.body.classList.toggle('tb-pos-' + p, p === pos));
  document.body.classList.toggle('tb-vertical', vertical);
  document.querySelectorAll('.pos-pick').forEach((b) => b.classList.toggle('active', b.dataset.pos === pos));
  if (save) {
    try { chrome.storage.local.set({ [TOOLBAR_POS_KEY]: pos }); } catch (e) { /* noop */ }
  }
}

// 「位置」ダイアログ(中央モーダル)の開閉と、十字ボタンの配線。
function setupPosDialog() {
  const dialog = document.getElementById('pos-dialog');
  const close = () => dialog.classList.remove('open');
  document.getElementById('layout-pos-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    dialog.classList.add('open');
  });
  document.getElementById('pos-dialog-close').addEventListener('click', close);
  // パネルの外(オーバーレイ)をクリックしたら閉じる。
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  // 押しても閉じない(実際の配置を見て確かめ、見比べられるように)。閉じるのは「閉じる」か外クリック。
  dialog.querySelectorAll('.pos-pick').forEach((b) =>
    b.addEventListener('click', () => applyToolbarPos(b.dataset.pos))
  );
}

// パフォーマンス計測パネル(📊)。FPS(このページの描画)・システムCPU%・システムメモリ%・
// JSヒープ・枠数を 1秒ごとに更新し、各値のスパークライン(直近 PERF_HISTORY 秒)を描く。
// パネルが開いている間だけ計測する(閉じれば rAF も interval も止めて負荷ゼロ)。
function setupPerfPanel() {
  const panel = document.getElementById('perf-panel');
  const rowsEl = panel.querySelector('.perf-rows');
  const btn = document.getElementById('perf-btn');

  const hist = { fps: [], cpu: [], mem: [], heap: [] };
  const ui = {};
  [['fps', 'FPS'], ['cpu', 'CPU'], ['mem', 'MEM'], ['heap', 'JS']].forEach(([key, label]) => {
    const row = document.createElement('div'); row.className = 'perf-row';
    const lab = document.createElement('span'); lab.className = 'perf-label'; lab.textContent = label;
    const val = document.createElement('span'); val.className = 'perf-val'; val.textContent = '–';
    const cv = document.createElement('canvas'); cv.className = 'perf-spark'; cv.width = 100; cv.height = 24;
    row.append(lab, val, cv);
    rowsEl.appendChild(row);
    ui[key] = { row, val, canvas: cv };
  });
  // 枠数(スパークラインなし)
  const cRow = document.createElement('div'); cRow.className = 'perf-row';
  const cLab = document.createElement('span'); cLab.className = 'perf-label'; cLab.textContent = '枠';
  const cVal = document.createElement('span'); cVal.className = 'perf-val'; cVal.textContent = '0';
  cRow.append(cLab, cVal); rowsEl.appendChild(cRow);

  const push = (k, v) => { const a = hist[k]; a.push(v); if (a.length > PERF_HISTORY) a.shift(); };
  const drawSpark = (cv, data, max, color, warn) => {
    const ctx = cv.getContext('2d'); const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    if (data.length < 2 || !max) return;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (PERF_HISTORY - 1)) * w;
      const y = h - 1 - Math.max(0, Math.min(v, max)) / max * (h - 2);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = warn ? '#f85149' : color; ctx.lineWidth = 1.5; ctx.stroke();
  };

  let frames = 0, rafId = null, tickId = null, prevCpu = null;
  const onFrame = () => { frames++; rafId = requestAnimationFrame(onFrame); };

  const sample = async () => {
    const fps = frames; frames = 0; push('fps', fps);

    let cpu = 0;
    try {
      const info = await chrome.system.cpu.getInfo();
      let user = 0, kernel = 0, total = 0;
      for (const p of info.processors) { user += p.usage.user; kernel += p.usage.kernel; total += p.usage.total; }
      if (prevCpu) {
        const dB = (user - prevCpu.user) + (kernel - prevCpu.kernel);
        const dT = total - prevCpu.total;
        cpu = dT > 0 ? Math.round((dB / dT) * 100) : 0;
      }
      prevCpu = { user, kernel, total };
    } catch (e) { /* noop */ }
    push('cpu', cpu);

    let mem = 0, memTitle = '';
    try {
      const m = await chrome.system.memory.getInfo();
      mem = Math.round((1 - m.availableCapacity / m.capacity) * 100);
      const usedGB = (m.capacity - m.availableCapacity) / 1073741824;
      const totGB = m.capacity / 1073741824;
      memTitle = '使用 ' + usedGB.toFixed(1) + ' / ' + totGB.toFixed(1) + ' GB';
    } catch (e) { /* noop */ }
    push('mem', mem);

    let heap = 0, heapMax = 0;
    if (performance.memory) {
      heap = Math.round(performance.memory.usedJSHeapSize / 1048576);
      heapMax = performance.memory.jsHeapSizeLimit / 1048576;
    }
    push('heap', heap);

    ui.fps.val.textContent = fps;
    ui.cpu.val.textContent = cpu + '%';
    ui.mem.val.textContent = mem + '%';
    ui.mem.row.title = memTitle;
    ui.heap.val.textContent = performance.memory ? heap + 'MB' : 'N/A';
    cVal.textContent = String(wins.length);

    ui.fps.val.classList.toggle('warn', fps < 30);
    ui.cpu.val.classList.toggle('warn', cpu > 85);
    ui.mem.val.classList.toggle('warn', mem > 90);

    drawSpark(ui.fps.canvas, hist.fps, 60, '#3fb950', fps < 30);
    drawSpark(ui.cpu.canvas, hist.cpu, 100, '#58a6ff', cpu > 85);
    drawSpark(ui.mem.canvas, hist.mem, 100, '#d29922', mem > 90);
    drawSpark(ui.heap.canvas, hist.heap, heapMax || Math.max(1, ...hist.heap), '#a371f7', false);
  };

  const start = () => {
    if (tickId) return;
    frames = 0; prevCpu = null;
    onFrame();
    tickId = setInterval(sample, 1000);
    sample();
  };
  const stop = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (tickId) { clearInterval(tickId); tickId = null; }
  };
  const toggle = () => {
    if (panel.hasAttribute('hidden')) {
      panel.removeAttribute('hidden'); btn.classList.add('on-blue'); start();
    } else {
      panel.setAttribute('hidden', ''); btn.classList.remove('on-blue'); stop();
    }
  };
  btn.addEventListener('click', toggle);
  document.getElementById('perf-close').addEventListener('click', toggle);
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
