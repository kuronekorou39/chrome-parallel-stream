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
const EDGE_KEEP = 100; // 枠/パネルがステージ外へはみ出しても、掴んで戻せるよう画面内に必ず残す可視量
const TOP_OVERHANG = 30; // 上方向へのはみ出し上限。台形ヘッダ(高さ62px)の半分は掴めるよう残す
const IDLE_CURSOR_MS = 3000; // この時間ポインタが動かないとカーソルを自動で消す(視聴の没入用)
const TOOLBAR_HIDE_MS = 30000; // この時間操作が無いとツールバーを自動で隠す(復帰は ≡メニュー)
const IS_COARSE = window.matchMedia('(pointer: coarse)').matches; // 主ポインタが指(スマホ/タブレット)か
const ZOOM_DEFAULT_FULL = 75; // 枠内サイト縮小率(🔍)の既定(全幅タイル)。一覧しやすいよう少し縮める
const ZOOM_DEFAULT_HALF = 50; // 同(50%幅タイル)。横に2つ並ぶ小さい枠なのでより縮める
const BAR_HIDE_MS = IS_COARSE ? 12000 : 4000; // 枠ヘッダ/ボタンの一時表示の自動消去。操作が無ければ完全に消す(映像に重ねない)。短いと押す前に消えるので長め
const STACK_CHAT_H = 280; // 縦積みモードで Kick チャットに足すタイル高(CSS の .win-chat と一致させること)
const RESTORE_STAGGER_MS = 1000; // 起動(更新)時、複数枠を一気に読まず順次読み込む間隔。同時読込による 429/初期化ピークを避ける
const LOAD_SPINNER_FALLBACK_MS = 8000; // 読み込みスピナーを必ず消す保険(load イベントが来ないサイト/エラー対策)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STACK_TALL_RATIO = 0.75; // 縦長タイルの高さ(ステージ高比)。⋮の「高さ切替」で縦長にした枠に使う
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

// スマホ縦積みモード: 指が主ポインタ かつ 狭い画面(940px はスマホ横持ちまで拾う閾値)。
// デスクトップでは URL に #stack を付けると強制オン(動作確認用)。
const stackMq = window.matchMedia('(pointer: coarse) and (max-width: 940px)');
let stackMode = false;

(async function init() {
  wireToolbar();
  setupIdleHide();
  updateStackMode();
  stackMq.addEventListener('change', updateStackMode);
  window.addEventListener('hashchange', updateStackMode); // #stack の付け外しで切替(動作確認用)
  window.addEventListener('resize', relayoutOnResize);
  window.addEventListener('message', onFrameUrl);
  window.addEventListener('message', onFrameAdState);
  window.addEventListener('message', onTileDragMsg); // frame内長押し → タイルドラッグの中継

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
  const deferred = []; // 表示するが中身は順次読み込む枠(更新時の同時読込を避ける)
  if (Array.isArray(saved.wins) && saved.wins.length) {
    saved.wins.slice(0, MAX_WINDOWS).forEach((it) => {
      const url = (it.url || '').trim();
      if (!url) return;
      // 枠とレイアウトは即作るが、表示枠の中身(iframe/動画)は後で順次読み込む(deferLoad)。
      // 隠していた枠は休止状態(未読込)のまま復元し、表示した時に初めて読み込む。
      const win = createWindow(url, { silent: true, startHidden: !!it.hidden, light: !!it.light, deferLoad: !it.hidden });
      if (win) {
        if (Number.isFinite(it.vol)) setWinVol(win, it.vol); // 台形/⋮メニュー/ミキサーの全スライダーへ反映
        if (it.tall === true || it.tall === false) win.tall = it.tall; // タイル高の手動指定を復元
        if (it.span === 'half') win.span = 'half'; // タイル幅(50%)を復元
        // 縮小率の手動指定だけ復元する。100 は「等倍を手動指定」だが、過去の既定100%データに
        // 引きずられて全部100%になるのを避けるため無視し、幅に応じた既定(75%/50%)へ戻す。
        if (Number.isFinite(it.zoom) && it.zoom >= 25 && it.zoom < 100) win.zoom = it.zoom; // 反映は読込時の mountSiteFrame
        syncMenuLabels(win);
        if (Number.isFinite(it.x)) {
          if (stackMode) {
            win.freeRect = { x: it.x, y: it.y, w: it.w, h: it.h }; // 自由配置へ戻った時のために保持
          } else {
            setRect(win, it.x, it.y, it.w, it.h);
            if (it.max) toggleMax(win);
          }
        }
        if (!it.hidden) deferred.push(win);
      }
    });
    if (stackMode) relayoutStack();
  } else {
    const urls = (saved.urls || []).map((u) => (u || '').trim()).filter((u) => u.length > 0).slice(0, MAX_WINDOWS);
    urls.forEach((u) => createWindow(u, { silent: true }));
    if (urls.length) tileAll(); // 旧データの初回だけ整列(以後は位置を保存・復元)
  }
  restoring = false; // 以後の移動/リサイズ/追加/削除は保存する
  updateCount();

  // 表示枠を 1 枠ずつ間隔をあけて読み込む(同時読込による Twitch の 429 や、IVS/デコードの
  // 初期化ピークでスマホが飽和して読込失敗するのを避ける)。各枠は読み込み中スピナーを出して待つ。
  for (let i = 0; i < deferred.length; i++) {
    if (i > 0) await sleep(RESTORE_STAGGER_MS);
    loadWindowMedia(deferred[i]);
  }
})();

// content script(stream-control.js)から「この枠が今開いている URL」を受け取り、
// 枠内で別の配信ページへ移動したら、その URL を保存して次回復元できるようにする。
function onFrameUrl(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true || d.type !== 'frame-url' || !d.href) return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win || win.url === d.href) return;
  if (win.light) return; // 軽量プレイヤー表示中はその URL で元ページ(win.url)を上書きしない
  win.url = d.href;
  updateWinTitle(win);
  syncLightBtn(win); // 配信ページへ移動したら⚡が押せるようになる
  saveLineup();
  renderMixer(); // 一覧のラベルも更新
}

// content script(stream-control.js)からの状態通知。
//  - ad-state: 広告検知中 → 「広告スキップ中」表示(.ad-skipping)を出す/消す。
//  - theater-state: 枠内シアター発動中 → バッジに 🎭 を出す(効いているかの確認用)。
function onFrameAdState(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true) return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win) return;
  if (d.type === 'ad-state') {
    win.el.classList.toggle('ad-skipping', !!d.adSkipping);
  } else if (d.type === 'theater-state') {
    win.theaterState = d.state; // 'on' | 'searching' | 'off'
    updateWinTitle(win); // バッジの 🎭/🔎 表示を更新
  } else if (d.type === 'frame-hello') {
    syncFrameTheater(win); // 起動した frame に現在のシアター設定を返す(読込すれ違い対策)
  }
}

// 現在の配信ラインナップ(URL+位置・サイズ+最大化)とマスタ音量を storage に保存。
// 専用ページを開き直すと、この内容で復元される(勝手に整列し直さない)。復元中は呼ばれても抑止。
function saveLineup() {
  if (restoring) return;
  const items = wins.map((w) => {
    // 縦積みモード中はタイル座標ではなく、退避してある自由配置の座標を保存する。
    const r = stackMode && w.freeRect ? w.freeRect : (w.maximized && w.prevRect ? w.prevRect : getRect(w));
    return {
      url: w.url,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
      max: !!w.maximized, vol: w.vol != null ? w.vol : 1, hidden: !!w.hidden, light: !!w.light,
      tall: w.tall == null ? null : !!w.tall, // 縦積みタイル高の手動指定(null=既定の16:9)
      span: w.span === 'half' ? 'half' : 'full', // 縦積みタイル幅(100%/50%)
      zoom: w.zoom // 枠内サイトの縮小率の手動指定(🔍。null=幅に応じた既定)
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
  const lightBtn = isKick ? null : mkBtn('⚡', '', ''); // 軽量プレイヤー切替(タイトルは syncLightBtn が設定)
  const adjustBtn = mkBtn('🎨', '', 'この枠の透明度・画質を調整');
  const maxBtn = mkBtn('⛶', 'max', '最大化/復元'); // 縦積みモードでは CSS で隠す
  const closeBtn = mkBtn('✕', 'close', '閉じる');
  controls.append(openBtn, reloadBtn);
  if (chatBtn) controls.append(chatBtn);
  if (lightBtn) controls.append(lightBtn);
  controls.append(adjustBtn, maxBtn, closeBtn);
  // [グリップ左][ タイトル + 音量 + ボタン = 枠移動ゾーン ] の順で台形ハンドルを組む。
  barMain.append(title, volWrap, controls);
  bar.append(gripL, barMain);

  const body = document.createElement('div');
  body.className = 'win-body';
  let frame = null;
  let video = null;
  let chatFrame = null;
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
    // 休止スタート(startHidden)や遅延読み込み(deferLoad)時は、表示/順次読込のタイミングで読む。
    if (!opts.startHidden && !opts.deferLoad) setupKickVideo(video, url, media);

    const channel = kickChannelOf(url);
    if (channel) {
      const chat = document.createElement('iframe');
      chat.className = 'win-chat';
      body.appendChild(chat);
      chatFrame = chat;
      // ログインCookieを埋め込みへ送れるよう緩めてからチャットを読み込む(投稿可能にする)。
      if (!opts.startHidden && !opts.deferLoad) {
        loadFrameWithLogin(chat, 'kick.com', 'https://kick.com/popout/' + encodeURIComponent(channel) + '/chat');
      }
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

  // タップはサイト/プレイヤーへそのまま通す(シールドは置かない)。タイルの掴み(長押し)は
  // 枠内の content script(stream-control.js)が検知して親へ中継する(onTileDragMsg)。
  el.append(bar, body, ...edges);
  stage.appendChild(el);

  const win = {
    id, url, el, body, frame, video, chatFrame, chatBtn, lightBtn, bar, barX: 0, titleEl: title, volSlider,
    maximized: false, hidden: false, light: false, tall: null, span: 'full', zoom: null,
    prevRect: null, freeRect: null,
    opacity: 100, vol: 1,
    filter: { bright: 100, contrast: 100, sat: 100 }
  };
  wins.push(win);

  // 縦積みモード用の簡易UI([⋮][✕]+メニュー。通常モードでは CSS で非表示)。
  el.appendChild(buildQuickControls(win));
  // 左上のモードバッジ。状態表示かつタップで 軽量⇄通常 を切替(枠ごとの軽量トグル)。
  // ヘッダ等と同様、操作が無ければ時間で消える(show-bar 連動)。
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'win-badge';
  badge.addEventListener('click', (e) => { e.stopPropagation(); revealHeader(win); toggleLight(win); });
  el.appendChild(badge);
  win.badgeEl = badge;

  // 軽量モードの復元(保存後に URL が変換できない形へ変わっていたら通常表示に落とす)。
  win.light = !!opts.light && !!toLightUrl(url);
  if (win.light && lightBtn) lightBtn.classList.add('active');
  updateWinTitle(win);
  syncLightBtn(win);

  const i = wins.length - 1;
  const cas = { x: 40 + (i % 6) * 30, y: 40 + (i % 6) * 30, w: 520, h: 320 }; // 新規枠の初期配置(カスケード)
  if (stackMode) {
    win.freeRect = cas; // 自由配置に戻った時の初期位置として保持
    relayoutStack();
  } else {
    setRect(win, cas.x, cas.y, cas.w, cas.h);
  }

  el.appendChild(buildAdjustPanel(win));

  el.addEventListener('pointerdown', () => { focusWindow(win); revealHeader(win); });
  // 縦積み: タイル長押しで浮かせてドラッグ並び替え(通常枠=シールド上 / Kick=映像上で効く)。
  el.addEventListener('pointerdown', (e) => maybeStartLongPress(win, e));
  // 長押しで Android のコンテキストメニュー(画像保存等)が誤爆しないように(縦積み中のみ)。
  el.addEventListener('contextmenu', (e) => { if (stackMode) e.preventDefault(); });
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
  if (lightBtn) lightBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLight(win); });
  adjustBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleAdjust(win); });
  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(win); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(win); });
  bar.addEventListener('dblclick', () => toggleMax(win));
  // サイト枠(非Kick)の iframe を生成。Kick は <video> なので applyVolume だけ。
  if (!isKick && !opts.startHidden && !opts.deferLoad) mountSiteFrame(win);
  applyVolume(win, masterVolume);

  if (opts.startHidden) {
    // 休止状態で開始(何も読み込んでいない)。表示時に resumeMedia() が読み込む。
    win.hidden = true;
    win.el.style.display = 'none';
  } else {
    focusWindow(win);
    if (opts.deferLoad) {
      // 枠は表示するが中身は後で(順次)読み込む。読み込み中スピナーを出しておく。
      win.pendingLoad = true;
      showWinLoading(win);
    }
  }
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
  // capLevelToPlayerSize: PC はサイズ変化で別品質の再取得をしない(無駄/事故防止)が、
  // スマホはデコード負荷が支配的なので、枠サイズ相応の画質へ自動で抑える。
  // worker: MV3 の CSP(script-src 'self')は blob worker を弾くため、同梱の hls.worker.js を
  // workerPath で明示して別スレッド解析にする(メインスレッドのカクつき軽減。失敗時は
  // hls.js が自動でメインスレッドへフォールバックする)。
  // スマホはさらにバッファを短くしてメモリを節約する。
  const hls = new Hls({
    capLevelToPlayerSize: IS_COARSE,
    enableWorker: true,
    workerPath: 'hls.worker.js',
    ...(IS_COARSE ? { maxBufferLength: 15, backBufferLength: 30 } : {})
  });
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
  // ステージ外へのはみ出しを許容する(端に寄せて部分表示できる)。ただし操作不能にならないよう
  // 左右・下は EDGE_KEEP px を画面内に残し、上は移動ハンドル(台形ヘッダ)が掴める範囲まで。
  x = Math.max(EDGE_KEEP - w, Math.min(x, sw - EDGE_KEEP));
  y = Math.max(-TOP_OVERHANG, Math.min(y, sh - EDGE_KEEP));
  win.el.style.left = x + 'px';
  win.el.style.top = y + 'px';
  win.el.style.width = w + 'px';
  win.el.style.height = h + 'px';
  updateWinWidthClass(win, w);
  clampBarX(win);
}

// 枠幅に応じて台形の中身を出し分けるクラスを付ける(旧 container-query の置き換え)。
// w を直接見るのでレイアウト読み取り(reflow)を起こさない。閾値は旧 @container と同じ。
// cq-narrow は縦積みの50%幅タイル用(右上の▲▼⋮✕を小さくし、バッジを下にずらして重なり回避)。
function updateWinWidthClass(win, w) {
  win.el.classList.toggle('cq-hide-title', w < 600);
  win.el.classList.toggle('cq-hide-vol', w < 500);
  win.el.classList.toggle('cq-narrow', w < 320);
}

// 台形ハンドルのスライド量をクランプする。枠内に収める(リサイズ/最大化ではみ出さない)のに加え、
// 枠がステージ外へはみ出している時は、ヘッダができるだけ画面内に残る位置へ寄せる
// (はみ出した枠をヘッダで掴んで戻せるように。可視部がバー幅より狭い時は見えている側へ寄せ切る)。
function clampBarX(win) {
  if (!win || !win.bar) return;
  const barW = win.bar.offsetWidth;
  const maxOff = Math.max(0, (win.el.clientWidth - barW) / 2);
  let x = Math.max(-maxOff, Math.min(maxOff, win.barX || 0));
  const left = win.el.offsetLeft;
  const lo = Math.max(-maxOff, -left - maxOff); // バー左端が画面左へ出ない下限
  const hi = Math.min(maxOff, stage.clientWidth - left - maxOff - barW); // バー右端が画面右へ出ない上限
  if (lo <= hi) x = Math.max(lo, Math.min(hi, x));
  else x = left < 0 ? maxOff : -maxOff;
  win.barX = x;
  win.el.style.setProperty('--bar-x', x + 'px');
}

function getRect(win) {
  // 休止中(display:none)は offset系が全部0を返すため、style から読む(常に px で保持している)。
  if (win.hidden) {
    return {
      x: parseFloat(win.el.style.left) || 0,
      y: parseFloat(win.el.style.top) || 0,
      w: parseFloat(win.el.style.width) || MIN_W,
      h: parseFloat(win.el.style.height) || MIN_H
    };
  }
  return { x: win.el.offsetLeft, y: win.el.offsetTop, w: win.el.offsetWidth, h: win.el.offsetHeight };
}

// ブラウザ窓のリサイズ時: 最大化窓はステージ全体へ再展開、その他はステージ内へ再クランプ。
function relayoutOnResize() {
  if (stackMode) {
    relayoutStack();
    return;
  }
  for (const w of wins) {
    if (w.maximized) {
      setRect(w, 4, 4, stage.clientWidth - 8, stage.clientHeight - 8);
    } else {
      const r = getRect(w);
      setRect(w, r.x, r.y, r.w, r.h);
    }
  }
}

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
  }
  wins.forEach((w) => sendTheaterEnabled(w, on && !w.light)); // モード切替を各フレームへ(軽量はシアター不要)
  wins.forEach((w) => applyFrameZoom(w)); // 既定縮小率がモードで変わる(自由配置=等倍 / 縦積み=75/50%)
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
  let pad = document.getElementById('stack-pad');
  if (!pad) {
    pad = document.createElement('div');
    pad.id = 'stack-pad';
    pad.style.cssText = 'position:absolute;width:1px;height:1px;visibility:hidden;';
    stage.appendChild(pad);
  }
  pad.style.left = '0px';
  // バーは縦積みでは非表示(offsetHeight=0)のため、≡メニューぶんの最低余白は常に確保する。
  pad.style.top = (y + Math.max(72, cs.contains('tb-pos-bottom') ? tb.offsetHeight : 0)) + 'px';
}

// 縦積みタイルの高さを幅から算出。既定は 16:9(Kickはチャット分を加算)。
// 縦長(手動指定)は全幅時のみ反映。half(横並び)は小さく出す枠なので常に 16:9。
function stackTileH(win, w, tallH) {
  let h = Math.round((w * 9) / 16);
  if (win.body && win.body.classList.contains('kick-split') && win.body.classList.contains('chat-on')) {
    h += STACK_CHAT_H;
  }
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

function maybeStartLongPress(win, e) {
  if (stackDrag || !e.isPrimary || e.button !== 0) return;
  if (win.el.classList.contains('stack-max')) return;
  if (e.target.closest('.win-quick, .win-menu, .win-badge, .win-adjust, .win-bar, .win-edge, button, input')) return;
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

// ドラッグ状態の生成と「浮かせる」見た目の適用(ローカル=親ポインタ / リモート=frame内中継 共通)。
// mode: 'stack'=縦積みの並び替え / 'free'=自由配置の任意位置移動。レイアウト(stackMode)で決まる。
function startStackDragState(win, clientX, clientY) {
  if (stackDrag || win.el.classList.contains('stack-max')) return false;
  focusWindow(win); // 浮いてる間は最前面に
  revealHeader(win);
  win.el.classList.remove('menu-open');
  win.el.classList.add('dragging');
  const mode = stackMode ? 'stack' : 'free';
  if (mode === 'stack') document.body.classList.add('reordering'); // 他タイルが席を空けるアニメ(縦積みのみ)
  // マウスのネイティブな選択・ドラッグ&ドロップ(リンク/画像/テキスト)を抑止する。これをしないと
  // 移動中に dragstart が起きてポインタ捕捉が外れ、「リンクを掴んだ」状態で離れてしまう。
  document.addEventListener('dragstart', blockNativeDrag, true);
  document.addEventListener('selectstart', blockNativeDrag, true);
  try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (_) { /* noop */ }
  if (navigator.vibrate) {
    try { navigator.vibrate(20); } catch (_) { /* noop */ } // 「浮いた」感触
  }
  const r = getRect(win);
  stackDrag = {
    win, mode,
    pid: null, // ローカルドラッグのときだけ設定
    remoteSrc: null, remoteSX: 0, remoteSY: 0, // リモートドラッグ(frame内中継)のときだけ設定
    startX: clientX, startY: clientY,
    lastX: clientX, lastY: clientY,
    startLeft: win.el.offsetLeft, startTop: win.el.offsetTop,
    startW: r.w, startH: r.h, // free: 移動中はサイズ維持
    startScroll: stage.scrollTop,
    lastReorder: 0,
    raf: null, autoV: 0
  };
  return true;
}

// ドラッグの移動処理。free=指の位置へ枠ごと移動(任意位置) / stack=浮かせて並び替え。
function applyDragMove() {
  const d = stackDrag;
  if (d.mode === 'free') {
    setRect(d.win, d.startLeft + (d.lastX - d.startX), d.startTop + (d.lastY - d.startY), d.startW, d.startH);
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
function onTileDragMsg(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true) return;
  if (d.type === 'tile-drag-start') {
    const win = wins.find((w) =>
      (w.frame && w.frame.contentWindow === e.source) ||
      (w.chatFrame && w.chatFrame.contentWindow === e.source));
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
  d.win.el.classList.remove('dragging');
  if (d.mode === 'stack') {
    relayoutStack(); // reordering のアニメが残っている間に席へ滑り込む
    setTimeout(() => document.body.classList.remove('reordering'), 200);
  }
  saveLineup();
  renderMixer();
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

// 縦積みモード用の簡易操作UI。台形ヘッダの代わりにタイル右上へ [⋮メニュー][✕閉じる] を出し、
// ⋮ から残りの機能(元サイト/再読込/チャット/軽量切替/調整/全画面/音量)へアクセスする。
// スマホでは「つまんで動かす」操作をしないため、ヘッダである必要が無い。
function buildQuickControls(win) {
  const quick = document.createElement('div');
  quick.className = 'win-quick';
  // 並び替えはタイルの長押しドラッグで行うので、つまむ用ボタンは置かない([⋮][✕]の2つだけ)。
  const menuBtn = mkBtn('⋮', '', 'この枠のメニュー');
  const closeBtn = mkBtn('✕', 'q-close', '閉じる');
  quick.append(menuBtn, closeBtn);

  const menu = document.createElement('div');
  menu.className = 'win-menu';
  const closeMenu = () => win.el.classList.remove('menu-open');
  // pointerdown 時点で確定(click 待ちだと、メニューが閉じた後の click が下の iframe へ
  // 振り直されてサイトに吸われることがある。preventDefault で click 合成も止める)。
  const mkItem = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      fn();
    });
    menu.appendChild(b);
    return b;
  };
  // トグル項目: 「項目名(左) + 現在値(右)」。タップで巡回。長い説明は title へ逃がして短く保つ。
  const mkToggle = (fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'win-menu-toggle';
    const name = document.createElement('span');
    const val = document.createElement('span');
    val.className = 'wm-val';
    b.append(name, val);
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (b.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      fn();
    });
    menu.appendChild(b);
    return { btn: b, name, val };
  };
  const mkSep = () => {
    const d = document.createElement('div');
    d.className = 'win-menu-sep';
    menu.appendChild(d);
  };

  // 表示・サイズ系(軽量 / 縮小 / 幅 / 高さ)。文言は syncLightBtn / syncMenuLabels が状態で更新。
  if (!win.video) win.menuLight = mkToggle(() => toggleLight(win));
  if (!win.video) win.menuZoom = mkToggle(() => cycleZoom(win)); // 縮小は枠内サイト用(Kickは映像のみで不要)
  win.menuSpan = mkToggle(() => toggleSpan(win));
  win.menuTall = mkToggle(() => toggleTall(win));
  mkSep();
  // 操作系。
  mkItem('⛶ 全画面で操作', () => toggleStackMax(win));
  if (win.chatFrame) mkItem('💬 チャット表示切替', () => toggleChat(win));
  mkItem('🎨 映像調整', () => toggleAdjust(win));
  mkItem('🔄 再読込', () => reloadWindow(win));
  mkItem('↗ 元サイトを新タブ', () => openOriginal(win));
  syncMenuLabels(win);

  // ⋮ は pointerdown で確定(タッチの合成 click が下の iframe へ漏れるのを防ぐ。反応も速い)。
  menuBtn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const willOpen = !win.el.classList.contains('menu-open');
    win.el.classList.toggle('menu-open');
    revealHeader(win); // メニュー操作中は隠さない
    if (willOpen) positionWinMenu(menuBtn, menu); // 画面外へはみ出さないよう配置
  });
  // ✕ は誤爆で枠が消えると困るので click のまま(押した本人の click が確実に閉じる)。
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(win); });
  quick.appendChild(menu); // ⋮ の直下にドロップダウンで出す
  return quick;
}

// ⋮メニューを画面内に収める。⋮ボタンを基準に position:fixed で配置し、右/下のはみ出しを補正する。
// (枠が画面端・下端にあるとメニューが見切れていたため。menu-open で表示済みなのでサイズを測れる)
function positionWinMenu(btn, menu) {
  const br = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.right = 'auto';
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.maxHeight = (window.innerHeight - 16) + 'px';
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const left = Math.max(8, Math.min(br.right - mw, vw - mw - 8)); // ⋮の右端に右端を揃え、画面内へ
  let top = br.bottom + 4;
  if (top + mh > vh - 8) {
    const above = br.top - mh - 4;
    top = above >= 8 ? above : Math.max(8, vh - mh - 8); // 下が無理なら上、それも無理なら画面内クランプ
  }
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

// ⋮メニューの可変ラベル(高さ・幅・縮小トグルの現在値)を状態に合わせて更新する。
function isTall(win) {
  return win.tall === true; // 既定は全枠 16:9。縦長は ⋮メニューの「高さ切替」で明示したときだけ
}
function syncMenuLabels(win) {
  if (win.menuTall) {
    win.menuTall.name.textContent = '⬍ 高さ';
    win.menuTall.val.textContent = isTall(win) ? '縦長' : '16:9';
    win.menuTall.btn.title = 'タップで ' + (isTall(win) ? '16:9' : '縦長') + ' に切替';
  }
  if (win.menuSpan) {
    win.menuSpan.name.textContent = '↔ 幅';
    win.menuSpan.val.textContent = win.span === 'half' ? '50%' : '100%';
    win.menuSpan.btn.title = 'タップで ' + (win.span === 'half' ? '100%' : '50%(横に2つ)') + ' に切替';
  }
  if (win.menuZoom) {
    win.menuZoom.name.textContent = '🔍 縮小';
    if (win.light) {
      win.menuZoom.btn.disabled = true; // 軽量プレイヤーは等倍必須(縮小すると自動再生が止まる)
      win.menuZoom.val.textContent = '等倍';
      win.menuZoom.btn.title = '軽量プレイヤーは等倍固定';
    } else {
      win.menuZoom.btn.disabled = false;
      const z = effectiveZoom(win);
      win.menuZoom.val.textContent = z + '%';
      win.menuZoom.btn.title = 'タップで ' + nextZoom(z) + '% に切替';
    }
  }
}

// 枠内シアター(視聴ページで video を枠いっぱいに固定)はスタックモード=スマホ縦積みのとき有効。
// 有効化は親主導で frame へ伝える(iframe 内の pointer:coarse 判定に頼らない)。
function sendTheaterEnabled(win, on) {
  if (!win.frame) return;
  try {
    win.frame.contentWindow.postMessage({ [MAGIC]: true, type: 'set-theater-enabled', value: !!on }, '*');
  } catch (e) { /* noop */ }
}

// ⛶全画面の間だけシアターを止めて素のサイトを操作できるようにする。
function sendTheaterSuspend(win, suspended) {
  if (!win.frame) return;
  try {
    win.frame.contentWindow.postMessage({ [MAGIC]: true, type: 'set-theater-suspend', value: !!suspended }, '*');
  } catch (e) { /* noop */ }
}

// frame の現在あるべきシアター状態をまとめて送る。
// 軽量プレイヤー(embed)はそのままで完成形=シアター不要。むしろ video 移動が embed の自動再生
// 可視性要件を壊して再生が止まるため、軽量枠ではシアターを無効にする。
function syncFrameTheater(win) {
  sendTheaterEnabled(win, stackMode && !win.light);
  if (win.el.classList.contains('stack-max')) sendTheaterSuspend(win, true);
}

// 枠内サイトの縮小率(100→75→50→100 で巡回)。仮想ビューポートを広げて scale で縮めるので、
// 16:9 の小さいタイルでもサイトの要素が大きすぎず、広い範囲が見えて操作しやすくなる。
function nextZoom(z) {
  return z === 100 ? 75 : z === 75 ? 50 : 100;
}
// 実効縮小率。手動指定(win.zoom)があればそれを使う。無ければ:
//  - 自由配置(PC)= 等倍100%(縮小は枠リサイズで足りる。縮小すると Twitch等が想定外レイアウトになる)
//  - 縦積み(スマホ)= 小さいタイルに合わせ 全幅75% / 50%幅50%
function effectiveZoom(win) {
  if (win.zoom != null) return win.zoom;
  if (!stackMode) return 100;
  return win.span === 'half' ? ZOOM_DEFAULT_HALF : ZOOM_DEFAULT_FULL;
}
function cycleZoom(win) {
  win.zoom = nextZoom(effectiveZoom(win));
  applyFrameZoom(win);
  syncMenuLabels(win);
  saveLineup();
}
function applyFrameZoom(win) {
  if (!win.frame) return;
  // 軽量プレイヤー(Twitch等の公式embed)は等倍必須。transform:scale は embed の自動再生
  // 可視性要件(Autoplay requirements)を壊して再生が止まるため、縮小を当てない。
  const z = win.light ? 100 : effectiveZoom(win);
  const f = win.frame;
  if (z === 100) {
    f.style.width = '';
    f.style.height = '';
    f.style.transform = '';
    f.style.transformOrigin = '';
  } else {
    // 例: 50% → 200%×200% の仮想ビューポートに描かせて 0.5 倍で表示する。
    const pct = (100 * 100) / z;
    f.style.width = pct + '%';
    f.style.height = pct + '%';
    f.style.transform = 'scale(' + z / 100 + ')';
    f.style.transformOrigin = '0 0';
  }
}

// タイルの高さを 16:9 ⇄ 縦長 で手動切替(既定は全枠 16:9)。
// 枠内のサイトをじっくり操作したい時だけ縦長にする(さっと操作するなら ⛶全画面でも可)。
function toggleTall(win) {
  win.tall = !isTall(win);
  syncMenuLabels(win);
  relayoutStack();
  saveLineup();
}

// タイル幅を 100% ⇄ 50% で切替。50% は横に2つ並ぶ(小さく出しておきたい枠用)。
// 並び順(ミキサーの ▲▼)で、どの50%枠どうしが横に並ぶかが決まる。
function toggleSpan(win) {
  win.span = win.span === 'half' ? 'full' : 'half';
  syncMenuLabels(win);
  applyFrameZoom(win); // 縮小率が既定(null)なら、幅に応じて 75%(全幅)⇄50%(半分)へ自動で切替わる
  relayoutStack();
  saveLineup();
}

// 縦積みモードの「全画面」: タイルを一時的に画面いっぱいへ広げる(枠内のサイト操作・配信選び用)。
// 解除は同じメニューか、画面下の「全画面を終了」ボタン。タイルの並びには影響しない。
function toggleStackMax(win) {
  const on = !win.el.classList.contains('stack-max');
  wins.forEach((w) => w.el.classList.remove('stack-max'));
  document.body.classList.toggle('has-stack-max', on);
  if (on) {
    win.el.classList.add('stack-max');
    focusWindow(win);
  }
  sendTheaterSuspend(win, on); // 全画面中は枠内シアターを止め、素のサイトを操作できるように
}

// 枠が全画面のまま閉じる/隠す/モード切替された時の後始末。
function clearStackMax(win) {
  if (win.el.classList.contains('stack-max')) {
    win.el.classList.remove('stack-max');
    document.body.classList.remove('has-stack-max');
  }
}

// 視聴モードでヘッダを一時的に表示し、数秒後にフェードで消す(クリック/タップ起点)。
function revealHeader(win) {
  win.el.classList.add('show-bar');
  clearTimeout(win.barTimer);
  win.barTimer = setTimeout(() => win.el.classList.remove('show-bar'), BAR_HIDE_MS);
}

// 選択(アクティブ枠・ヘッダ表示・⋮メニュー)をすべて解除する。
function clearSelection() {
  if (activeWin) activeWin.el.classList.remove('active');
  activeWin = null;
  wins.forEach((w) => { w.el.classList.remove('show-bar', 'adjust-open', 'menu-open'); clearTimeout(w.barTimer); });
}

// 台形ハンドル: つまむ位置で挙動を分ける(RDP風)。
//  - 両端のグリップ(.win-grip): ヘッダを枠の上辺に沿って左右にスライド(両端で止まる)。
//  - 中央の本体(.win-bar-main): つかむと枠を移動。
// ポインタをキャプチャするので iframe/動画の上をドラッグしても追従する。ボタン上では発火しない。
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
    try { bar.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    const onMove = (ev) => {
      if (slideMode) {
        win.barX = startBarX + (ev.clientX - sx);
        clampBarX(win); // 枠内+画面内に収めて反映
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
  if (stackMode || e.button !== 0 || !e.isPrimary || win.maximized) return; // 縦積み中はリサイズなし
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
  if (stackMode) return; // 縦積み中は常に整列済み(⛶ボタン自体も CSS で隠している)
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
  if (stackMode) {
    relayoutStack(); // 縦積み中の「整列」= 積み直し
    return;
  }
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
  if (stackMode) relayoutStack(); // チャット分のタイル高が変わる
}

// サイト枠(Twitch/YouTube/OPENREC)の iframe を生成して body に載せる。
// 軽量モード(win.light)の枠は、フルサイトではなく公式埋め込みプレイヤーだけを読み込む。
function mountSiteFrame(win) {
  const frame = document.createElement('iframe');
  frame.allow = IFRAME_ALLOW;
  win.body.appendChild(frame);
  win.frame = frame;
  applyFrameZoom(win); // 縮小表示(🔍)の倍率を反映
  frame.addEventListener('load', () => {
    applyVolume(win, masterVolume);
    syncFrameTheater(win); // シアター有効化(+全画面中なら一時停止)を伝える
    hideWinLoading(win); // 読み込み中スピナーを消す(出ていれば)
  });
  const src = (win.light && toLightUrl(win.url)) || toEmbedUrl(win.url);
  // ログインCookieを埋め込みへ通す(SameSite緩和)。対象サイトのみ(src 基準で判定)。
  const loginDomain = loginDomainOf(hostOf(src));
  if (loginDomain) {
    loadFrameWithLogin(frame, loginDomain, src);
  } else {
    frame.src = src;
  }
  applyVolume(win, masterVolume);
}

// 枠の iframe を作り直す(軽量⇄通常の切替・再読込用)。休止中なら次の表示時に反映される。
function remountFrame(win) {
  if (win.frame) {
    win.frame.remove();
    win.frame = null;
  }
  if (!win.hidden) mountSiteFrame(win);
}

// ⚡ 軽量プレイヤー切替。サイト内回遊・チャットは使えなくなる(戻すのも⚡)。
function toggleLight(win) {
  if (win.video) return; // Kick は元から HLS 直再生(常時軽量)
  if (!win.light && !toLightUrl(win.url)) return; // 変換先が無いURL(トップ等)では何もしない
  win.light = !win.light;
  win.tall = null; // 高さの手動指定はリセット(既定の16:9へ)
  if (win.lightBtn) win.lightBtn.classList.toggle('active', win.light);
  updateWinTitle(win);
  syncLightBtn(win);
  syncMenuLabels(win);
  remountFrame(win);
  relayoutStack(); // 高さの既定が変わる(縦積み中のみ動作)
  saveLineup();
  renderMixer();
}

// ツールバーの「⚡ 軽量」: 切替できる通常枠が1つでもあれば全部軽量へ、無ければ全部通常へ戻す。
function toggleAllLight() {
  const on = wins.some((w) => !w.video && !w.light && toLightUrl(w.url));
  wins.forEach((w) => {
    if (w.video || w.light === on) return;
    if (on && !toLightUrl(w.url)) return; // 変換できない枠(トップページ等)はそのまま
    w.light = on;
    w.tall = null; // 高さの手動指定はリセット(既定の16:9へ)
    if (w.lightBtn) w.lightBtn.classList.toggle('active', on);
    updateWinTitle(w);
    syncLightBtn(w);
    syncMenuLabels(w);
    remountFrame(w);
  });
  relayoutStack(); // 高さの既定が変わる(縦積み中のみ動作)
  saveLineup();
  renderMixer();
}

// ⚡ボタン(台形ヘッダ/⋮メニュー両方)の活性・文言を現在の状態・URLに合わせる。
function syncLightBtn(win) {
  const ok = win.light || !!toLightUrl(win.url);
  if (win.lightBtn) {
    win.lightBtn.disabled = !ok;
    win.lightBtn.title = win.light
      ? '通常表示に戻す(サイト内回遊・チャットが使える)'
      : ok
        ? '軽量プレイヤーに切替(負荷を大きく削減。回遊・チャット不可)'
        : '軽量プレイヤーは配信/動画ページを開くと使えます';
  }
  if (win.menuLight) {
    win.menuLight.btn.disabled = !ok;
    win.menuLight.name.textContent = win.light ? '🌐 通常' : '⚡ 軽量';
    win.menuLight.val.textContent = '';
    win.menuLight.btn.title = win.light
      ? '通常表示に戻す(サイト内回遊・チャットが使える)'
      : ok ? '軽量プレイヤーに切替(負荷を大きく削減・回遊不可)' : '軽量は配信/動画ページで使えます';
  }
}

// 枠をその場で再読込する(🔄)。iframe は作り直し、Kick は HLS を貼り直す。
function reloadWindow(win) {
  if (win.frame) {
    remountFrame(win); // 現在の win.url(と軽量モード)で iframe を作り直す
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
  clearStackMax(win); // 全画面のまま閉じても body の状態を残さない
  hideWinLoading(win); // 読み込み待ち中に閉じてもスピナー/保険タイマーを残さない
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

// 音量を枠へ反映。実音量 = 枠ごと音量(win.vol) × マスタ(v)。
// muted もスライダーが所有する(>0 で解除 / 0 でミュート)。スマホの縦積みではシールドにより
// プレイヤーUIへ触れないため、スライダーだけで確実に音が出る/消えることを保証する。
// 「1つだけ聞く」は他の枠の音量を 0 にして行う(プレイヤー自前のミュートには頼らない)。
// マスタを動かすと全枠が同倍率で増減 → 枠ごとの大小関係(win.vol の比)は保たれる。
// 確実に効く video.volume を当てる(Kick の <video> はここ=親で、iframe 内は content script 経由で)。
function applyVolume(win, v) {
  const eff = win.hidden ? 0 : Math.max(0, Math.min(1, (win.vol != null ? win.vol : 1) * v));
  if (win.video) {
    try {
      win.video.volume = eff;
      win.video.muted = eff <= 0;
    } catch (e) { /* noop */ }
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

// 枠を「隠す=休止 / 表示=再開」。隠しても位置・サイズ・URLは保持するが、メディアは完全に
// 読み込みを止める(display:none でも再生・通信は続いてしまい、特にスマホで重いため)。
function hideWindow(win) {
  clearStackMax(win);
  win.hidden = true;
  win.el.style.display = 'none';
  suspendMedia(win);
  if (stackMode) relayoutStack(); // 空いた分を詰める
  renderMixer();
  saveLineup();
}
function showWindow(win) {
  win.hidden = false;
  win.el.style.display = '';
  resumeMedia(win);
  applyVolume(win, masterVolume);
  focusWindow(win); // 出したら最前面へ
  if (stackMode) {
    relayoutStack();
    win.el.scrollIntoView({ block: 'nearest' });
  }
  renderMixer();
  saveLineup();
}
function toggleHidden(win) { win.hidden ? showWindow(win) : hideWindow(win); }

// 休止: 枠のメディアの読み込み・再生を完全に止める(枠の DOM と URL は保持)。
function suspendMedia(win) {
  win.pendingLoad = false; // 順次読込待ち中に隠したら、読込予約を取り消してスピナーも消す
  hideWinLoading(win);
  if (win.video) {
    if (win.video._hls) {
      try { win.video._hls.destroy(); } catch (e) { /* noop */ }
      win.video._hls = null;
    }
    try { win.video.pause(); } catch (e) { /* noop */ }
    win.video.removeAttribute('src');
    try { win.video.load(); } catch (e) { /* noop */ } // src 解放を確定させる
    if (win.chatFrame) win.chatFrame.src = 'about:blank';
  } else if (win.frame) {
    win.frame.remove(); // iframe ごと破棄(再開時に mountSiteFrame で作り直す)
    win.frame = null;
  }
}

// 再開: 休止中だったメディアを win.url から読み込み直す(休止していなければ何もしない)。
function resumeMedia(win) {
  if (win.video) {
    if (!win.video._hls && !win.video.src) {
      const media = win.video.parentElement;
      if (media) media.querySelectorAll('.win-error').forEach((el) => el.remove());
      setupKickVideo(win.video, win.url, media);
    }
    if (win.chatFrame) {
      const channel = kickChannelOf(win.url);
      const src = win.chatFrame.getAttribute('src');
      if (channel && (!src || src === 'about:blank')) {
        loadFrameWithLogin(win.chatFrame, 'kick.com', 'https://kick.com/popout/' + encodeURIComponent(channel) + '/chat');
      }
    }
  } else if (!win.frame) {
    mountSiteFrame(win);
  }
}

// ====== 読み込み中スピナー / 遅延読み込み ======

// 枠の中身(映像)の上に読み込み中スピナーを出す/消す。表示は枠の body に重ねる。
function showWinLoading(win) {
  if (!win.body || win.loadingEl) return;
  const el = document.createElement('div');
  el.className = 'win-loading';
  const sp = document.createElement('div');
  sp.className = 'win-spinner';
  const label = document.createElement('div');
  label.className = 'win-loading-label';
  label.textContent = '読み込み中…';
  el.append(sp, label);
  win.body.appendChild(el);
  win.loadingEl = el;
}
function hideWinLoading(win) {
  if (win.loadingTimer) { clearTimeout(win.loadingTimer); win.loadingTimer = null; }
  if (win.loadingEl) { win.loadingEl.remove(); win.loadingEl = null; }
}

// 遅延読み込み(deferLoad)で待たせていた枠の中身を、今このタイミングで読み込む。
// スピナーは読み込み完了(iframe load / video の loadeddata)か、保険タイマーで消す。
function loadWindowMedia(win) {
  if (!win || !win.pendingLoad) return;
  win.pendingLoad = false;
  if (win.video) {
    win.video.addEventListener('loadeddata', () => hideWinLoading(win), { once: true });
  }
  // iframe は mountSiteFrame の load ハンドラが hideWinLoading を呼ぶ。
  win.loadingTimer = setTimeout(() => hideWinLoading(win), LOAD_SPINNER_FALLBACK_MS);
  resumeMedia(win);
}

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
    // 1行目: 枠名(URL)+ 👁、2行目: 音量つまみ(全幅)。URLが見切れにくく、音量も掴みやすい。
    const row = document.createElement('div');
    row.className = 'mixer-row' + (win.hidden ? ' is-hidden' : '');
    row.dataset.id = win.id;

    const top = document.createElement('div');
    top.className = 'mixer-row-top';

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'mixer-row-label';
    label.textContent = winLabel(win); // 軽量プレイヤー中は ⚡ 付き
    label.title = 'クリックで最前面に表示';
    label.addEventListener('click', () => {
      if (win.hidden) {
        showWindow(win);
      } else {
        focusWindow(win);
        if (stackMode) win.el.scrollIntoView({ block: 'nearest' }); // タイルの位置まで送る
      }
    });

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'mixer-row-eye';
    eye.textContent = win.hidden ? '🙈' : '👁';
    eye.title = win.hidden ? '再開する(読み込み直す)' : '休止する(読み込みを止める。位置・サイズ・URLは保持)';
    eye.addEventListener('click', () => toggleHidden(win));
    top.append(label, eye);

    const bot = document.createElement('div');
    bot.className = 'mixer-row-bot';
    const volIcon = document.createElement('span');
    volIcon.className = 'mixer-row-vol-icon';
    volIcon.textContent = '🔊';
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '100';
    vol.value = String(Math.round((win.vol != null ? win.vol : 1) * 100));
    vol.className = 'mixer-row-vol';
    vol.title = 'この枠の音量';
    vol.addEventListener('input', () => setWinVol(win, Number(vol.value) / 100));
    vol.addEventListener('change', () => saveLineup());
    bot.append(volIcon, vol);

    row.append(top, bot);
    list.appendChild(row);
  });
}

// ミキサーパネルの配線(トグル/閉じる/マスタ/ドラッグ)。サイズ変更は不要なのでリサイズは無し。
function setupMixer() {
  const panel = document.getElementById('mixer-panel');
  makePanelDraggable(panel, panel.querySelector('.mixer-head'));
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
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    const onMove = (ev) => {
      // 枠と同じく EDGE_KEEP px を画面内に残してはみ出しを許容する。
      // 上はドラッグハンドル(ヘッダ)がパネル先頭にあるので 0 で止める(出すと掴めなくなる)。
      const minL = EDGE_KEEP - el.offsetWidth;
      const maxL = stage.clientWidth - EDGE_KEEP;
      const maxT = Math.max(0, stage.clientHeight - EDGE_KEEP);
      el.style.left = Math.max(minL, Math.min(maxL, sl + ev.clientX - sx)) + 'px';
      el.style.top = Math.max(0, Math.min(maxT, st + ev.clientY - sy)) + 'px';
    };
    const end = () => {
      document.body.classList.remove('panel-dragging');
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
  // ⚡ 軽量プレイヤー一括切替(押すたびに 全部軽量 ⇄ 全部通常。枠ごとの個別切替はヘッダの⚡)。
  document.getElementById('light-btn').addEventListener('click', toggleAllLight);
  // 縦積みの「全画面」からの復帰ボタン(全画面中だけ画面下に出る)。
  document.getElementById('stack-restore').addEventListener('click', () => {
    const w = wins.find((x) => x.el.classList.contains('stack-max'));
    if (w) toggleStackMax(w);
  });
  // 透明度・画質は枠ごとの設定なので、各枠ヘッダの 🎨 から開く調整パネルに置く
  // (ツールバーに置くと音量のようなマスタ設定に見えてしまうため)。
  document.getElementById('toolbar-toggle').addEventListener('click', () => document.body.classList.add('toolbar-hidden'));
  // ≡ は常に縦リストのメインメニューを開閉する(PC含め、バー型ツールバーは使わない)。
  document.getElementById('toolbar-show').addEventListener('click', () => toggleMainMenu());
  setupMainMenu();

  // 「＋追加」→ 追加ダイアログ(サイトボタン / URL入力)。ツールバーをすっきりさせるため別モーダルに。
  const addDialog = document.getElementById('add-dialog');
  const closeAdd = () => addDialog.classList.remove('open');
  const openAdd = (e) => { e.stopPropagation(); addDialog.classList.add('open'); };
  document.getElementById('add-open-btn').addEventListener('click', openAdd);
  document.getElementById('empty-add-btn').addEventListener('click', openAdd); // 空ステージの大ボタンからも開ける
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

// ====== スマホ用メインメニュー(縦リスト) ======
// スマホ(縦積み)ではツールバーのバー表示をやめ、≡ から右クリックメニュー風の縦リストを出す。
// 項目: 追加・整列・一覧・広告スキップ・パフォーマンス(音量/並びはミキサー、軽量は各枠のバッジ)。
// 機能は既存ツールバーボタンを programmatic click して呼ぶ(状態・ロジックの二重化を避ける)。

function toggleMainMenu(force) {
  const menu = document.getElementById('main-menu');
  const backdrop = document.getElementById('main-menu-backdrop');
  const show = force != null ? force : menu.hidden;
  if (show) syncMainMenu();
  menu.hidden = !show;
  if (backdrop) backdrop.hidden = !show;
}

// 開くたびに状態表示(広告スキップの ON/OFF)を現物のボタンから読み直す。
function syncMainMenu() {
  const adOn = document.getElementById('adskip-btn').classList.contains('adskip-on');
  const ad = document.getElementById('mm-adskip');
  ad.textContent = adOn ? '⏭ 広告スキップ: ON' : '⏭ 広告スキップ: OFF';
  ad.classList.toggle('on', adOn);
}

function setupMainMenu() {
  // 項目は pointerdown 時点で確定する。click 待ちだと、処理中にメニューが消えた場合に
  // ブラウザが click を「いま指の下の要素=下のタイルの iframe」へ振り直してしまうため
  // (preventDefault で後続の click 合成自体も止める)。
  const mkAct = (id, fn) => {
    document.getElementById(id).addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  };
  const act = (id, fn) => mkAct(id, () => { toggleMainMenu(false); fn(); });
  act('mm-add', () => document.getElementById('add-open-btn').click());
  act('mm-tile', tileAll);
  act('mm-mixer', () => document.getElementById('mixer-btn').click());
  act('mm-perf', () => document.getElementById('perf-btn').click());
  // 広告スキップはトグルなので閉じずに、その場で ON/OFF 表示を更新する。
  mkAct('mm-adskip', () => {
    document.getElementById('adskip-btn').click();
    syncMainMenu();
  });
  // 透明バックドロップ: メニュー外のタップは「閉じる」だけで、下のタイルへは絶対に流さない。
  document.getElementById('main-menu-backdrop').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMainMenu(false);
  });
}

// ポインタが一定時間動かなかったら、まずカーソルを消し(IDLE_CURSOR_MS)、さらに操作が無ければ
// ツールバーも隠す(TOOLBAR_HIDE_MS。すぐ消えると使いづらいのでメニューは長めに残す)。
// 復帰は ≡メニュー(#toolbar-show)から。マウスを動かした時はカーソルだけ戻し、ツールバーは出さない
// (= 明示的にボタンを押した時だけ出す)。タッチ(pointer)でも同様に働く。
function setupIdleHide() {
  const toolbar = document.getElementById('toolbar');
  let cursorTimer = null;
  let toolbarTimer = null;
  // ツールバー上にポインタがある(操作中)なら消さない/隠さない。離れて静止すれば次の動きで再武装される。
  const hideCursor = () => {
    if (toolbar.matches(':hover')) return;
    document.body.classList.add('idle');
  };
  const hideToolbar = () => {
    if (toolbar.matches(':hover')) return;
    document.body.classList.add('toolbar-hidden');
  };
  let lastArm = 0;
  const arm = () => {
    document.body.classList.remove('idle'); // カーソルを戻す(toolbar-hidden は触らない)
    const now = Date.now();
    if (now - lastArm < 250) return; // pointermove 連発でのタイマ再生成を間引く(精度より省電力)
    lastArm = now;
    clearTimeout(cursorTimer);
    clearTimeout(toolbarTimer);
    cursorTimer = setTimeout(hideCursor, IDLE_CURSOR_MS);
    toolbarTimer = setTimeout(hideToolbar, TOOLBAR_HIDE_MS);
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
  relayoutStack(); // 縦積み中はツールバーの避け方が変わるので積み直す(自由配置では何もしない)
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
  // ヘッダをつかんで移動できるようにする(ミキサーと同じ仕組み。閉じる✕の上では動かない)。
  makePanelDraggable(panel, panel.querySelector('.perf-head'));

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

// 軽量プレイヤー(⚡)用: 視聴ページの URL を各サイトの公式埋め込みプレイヤー URL に変換する。
// フルサイトの SPA を丸ごと読まずプレイヤーだけになるので、1枠あたりの負荷が大きく下がる。
// 変換先が無い URL(サイトのトップ・一覧ページ等)は null(=切替不可)。
function toLightUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  const host = u.hostname;
  const segs = u.pathname.split('/').filter(Boolean);

  // 自動再生は「ミュート付き」で要求する。モバイルは音あり自動再生が禁止のため、ミュート無しだと
  // 一時停止で止まったまま開く。本アプリは元々「起動時は全ミュート」方針なので挙動も一致する。
  if (host.includes('youtube.com') || host === 'youtu.be') {
    let id = null;
    if (host === 'youtu.be') id = segs[0];
    else if (segs[0] === 'watch') id = u.searchParams.get('v');
    else if (segs[0] === 'live' || segs[0] === 'shorts' || segs[0] === 'embed') id = segs[1];
    if (!id) return null;
    return 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?autoplay=1&playsinline=1&mute=1';
  }

  if (host.includes('twitch.tv')) {
    if (host.startsWith('player.')) return null; // 既に埋め込みプレイヤー
    // parent は埋め込み元ホスト名(=拡張ID)。検証用の frame-ancestors CSP は rules.json が
    // sub_frame で剥がすため、形式さえ合っていれば拡張ページからでも再生できる(実機確認済み)。
    const tail = '&autoplay=true&muted=true&parent=' + encodeURIComponent(location.hostname);
    if (segs[0] === 'videos' && segs[1]) {
      return 'https://player.twitch.tv/?video=' + encodeURIComponent(segs[1]) + tail;
    }
    const nonChannel = ['directory', 'search', 'settings', 'subscriptions', 'inventory', 'drops', 'wallet', 'turbo', 'jobs', 'p'];
    if (segs.length && !nonChannel.includes(segs[0])) {
      return 'https://player.twitch.tv/?channel=' + encodeURIComponent(segs[0]) + tail;
    }
    return null;
  }

  if (host.includes('openrec.tv')) {
    if ((segs[0] === 'live' || segs[0] === 'movie') && segs[1]) {
      return 'https://www.openrec.tv/embed/' + encodeURIComponent(segs[1]);
    }
    return null;
  }

  return null;
}

function labelFor(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname;
  } catch (e) {
    return url;
  }
}

// 枠の表示名(軽量プレイヤー中は ⚡ を付けて区別)。台形ヘッダとミキサーの両方で使う。
function winLabel(win) {
  return (win.light ? '⚡ ' : '') + labelFor(win.url);
}

function updateWinTitle(win) {
  if (win.titleEl) win.titleEl.textContent = winLabel(win);
  // 左上バッジを更新(どのモードかひと目でわかるように。Kick は常時 HLS 直再生=軽量)。
  if (win.badgeEl) {
    const light = !!win.light || !!win.video;
    // 🎭=シアター動作中 / 🔎=有効だが主映像を探索中(診断用。frame 内 stream-control からの通知)。
    const mark = win.theaterState === 'on' ? ' 🎭' : win.theaterState === 'searching' ? ' 🔎' : '';
    win.badgeEl.textContent = (light ? '⚡ 軽量' : '通常') + mark;
    win.badgeEl.classList.toggle('light', light);
    // Kick は切替不可。通常⇄軽量できる枠だけタップのヒントを出す。
    const canToggle = !win.video && (win.light || !!toLightUrl(win.url));
    win.badgeEl.disabled = !canToggle;
    win.badgeEl.title = canToggle
      ? (win.light ? 'タップで通常表示に戻す' : 'タップで軽量プレイヤーに切替')
      : '';
  }
}
