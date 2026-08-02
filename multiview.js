// マルチビュー本体ページの「ページ内ウィンドウマネージャ」。
// storage(MULTIVIEW_ACTIVE_KEY)の URL 群を読み、各配信を iframe のフローティング窓として
// ステージ上に並べる。ドラッグ移動・右下リサイズ・重ね(z-order)・最大化・整列に対応。
// 音声はクロスオリジンで直接触れないため、各フレームの content script(stream-control.js)へ
// postMessage で muted/volume を指示する。起動時は全ミュート、各窓の S(ソロ)で1つだけ鳴らす。

const MULTIVIEW_ACTIVE_KEY = 'multiviewActive';
const MULTIVIEW_LAYOUTS_KEY = 'multiviewLayouts';
const MAX_LAYOUTS = 30;
// 枠内でログインを使うために Cookie の SameSite を緩めるか。既定は ON(緩める)。
// OFF にすると枠は未ログイン表示になり、チャットへの書き込み等ができなくなる。
const COOKIE_RELAX_KEY = 'cookieRelaxEnabled';
let cookieRelaxOn = true; // 起動時に storage から読み直す
const MAX_WINDOWS = 20;
// 枠の最小サイズ。CSS の .win min-width / min-height と一致させること。
// リサイズのつまみは右下の1点だけで場所を取らないため、小さめの枠も並べられるようにしてある。
// 枠の最小サイズ。CSS の .win min-width / min-height と一致させること。
// 16:9(240p の標準サイズ)にそろえてある。映像がこの比率なので、最小まで縮めても形が崩れない。
// 右下のリサイズつまみが常に原寸で収まる大きさでもある。つまみは隅から 88px 内側に 90px 角で
// 置くので幅・高さとも最低 178px を占めるが、この値ならどちらも余裕がある。
// 下げるとつまみが枠外へ出て overflow:hidden で消え、リサイズできなくなるので注意
// (CSS の --grip-inset-r / --grip-inset-b / --grip-size を変えたときも合わせて見直すこと)。
const MIN_W = 426;
const MIN_H = 240; // 426:240 = 16:9
const SNAP_GAP = 6; // 整形(グリッドスナップ)時の枠どうしの隙間
const EDGE_KEEP = 100; // 枠/パネルがステージ外へはみ出しても、掴んで戻せるよう画面内に必ず残す可視量
const TOP_OVERHANG = 30; // 上方向へのはみ出し上限。台形ヘッダ(高さ62px)の半分は掴めるよう残す
const IDLE_CURSOR_MS = 10000; // この時間ポインタが動かないとカーソル+常駐UI/機能パネルを自動で消す(視聴の没入用)
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

// コメント弾幕(チャットを右→左へ流す)。
const DMK_GAP = 44;          // 同じレーンで前の弾幕の後ろに空ける最小間隔(px)
const DMK_MAX_NODES = 120;   // 1枠の同時表示上限(高密度チャットでの暴発保険)
const DMK_MIN_SCALE = 0.4;        // 「長文を縮小」の下限倍率(これより小さくはしない)
const DMK_SPEED_REF_LEN = 18;     // 「長さで速度」: この文字数で等倍、超えるほど速い
const DMK_SPEED_MAX_FACTOR = 2.6; // 同上の速度上限倍率
// 弾幕の共通(既定)設定。枠ごとに win.danmaku.overrides で部分上書きできる(上書きの無い枠は全体に追従)。
const DMK_DEFAULTS = {
  fontSize: 22,            // 文字サイズ(px)
  speed: 180,              // 流れる速さ(px/秒)
  opacity: 30,             // 弾幕の不透明度(%)。映像を邪魔しない程度に薄く
  useColor: true,          // チャットのユーザー色を使う
  colorStrength: 25,       // 色の強さ(0=白 〜 100=原色。白とのブレンド率)
  longShrink: true,        // 長文を縮小(しきい値超で長いほど小さく)
  longShrinkThreshold: 30, // 縮小を始める文字数
  speedByLength: false     // 長さで速度変化(長いほど速く流す)
};
let dmkGlobal = Object.assign({}, DMK_DEFAULTS);
// 設定パネルのコントロール定義(全体/この枠 共通)。
// adv:true は「詳細」に畳む項目。まず出すのは普段いじる4つだけにして、最初の見た目を軽くする。
// 詳細側は種類ごと(group)にまとめて表示するので、同じ group の項目が連続するよう並べること。
// 簡易側の3つは steps を持つ。数値を自由に決めるのではなく、用意した段階から選ぶだけにする
// (つまみは段階のインデックスを動かし、目盛りと名前を出す)。実際に保存されるのは steps の値。
// 既定値(22 / 180 / 30)は必ず steps に含めること。含めないと初期状態がどの段階にも一致しない。
const DMK_CONTROLS = [
  { key: 'fontSize', label: '文字サイズ', type: 'range', min: 12, max: 48, unit: 'px', group: 'サイズ',
    steps: [14, 18, 22, 28, 36], stepNames: ['極小', '小', '中', '大', '特大'] },
  { key: 'speed', label: '速さ', type: 'range', min: 40, max: 400, unit: '', group: '速度',
    steps: [100, 140, 180, 240, 320], stepNames: ['とても遅い', '遅い', 'ふつう', '速い', 'とても速い'] },
  { key: 'opacity', label: '不透明度', type: 'range', min: 20, max: 100, unit: '%', group: '表示',
    steps: [20, 30, 50, 75, 100], stepNames: ['ごく薄い', '薄い', 'ふつう', '濃い', 'くっきり'] },
  { key: 'longShrink', label: '長文を縮小', type: 'toggle', group: 'サイズ', adv: true },
  { key: 'longShrinkThreshold', label: '縮小しきい', type: 'range', min: 10, max: 80, unit: '字', group: 'サイズ', adv: true },
  { key: 'speedByLength', label: '長さで速度', type: 'toggle', group: '速度', adv: true },
  { key: 'useColor', label: '色を使う', type: 'toggle', group: '色', adv: true },
  { key: 'colorStrength', label: '色の強さ', type: 'range', min: 0, max: 100, unit: '%', group: '色', adv: true }
];

// 枠(iframe)に表示できるサイト。rules.json が X-Frame-Options / CSP を剥がしている対象と
// 一致させること。ここに無いサイトは、サイト側の埋め込み拒否がそのまま効いて「接続拒否」になる。
// 対象を増やすことは、そのドメインの埋め込み防御を利用者のブラウザで外すことを意味するので、
// 安易に足さない(README の「この拡張がブラウザに与える影響」も合わせて更新すること)。
const EMBEDDABLE_HOSTS = ['twitch.tv', 'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'kick.com', 'openrec.tv', 'mellow-fan.com'];
function isEmbeddableHost(host) {
  const h = String(host || '').toLowerCase();
  return EMBEDDABLE_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

// 枠として読み込んでよい URL か(スキームとホストの両方を見る)。
// http(s) 以外を弾くのは、UI ページを通常オリジンへ置いてページ側の CSP が無くなったため、
// javascript: 等がこのページの文脈で実行されうるのを防ぐため。
function isAllowedFrameUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return isEmbeddableHost(u.hostname);
  } catch (e) {
    return false;
  }
}

// ツールバーのワンクリックで開く主要4サイト(各サイトのトップを開き、枠内でライブを選ぶ)。
const SITES = {
  twitch: { url: 'https://www.twitch.tv/' },
  youtube: { url: 'https://www.youtube.com/' },
  kick: { url: 'https://kick.com/' },
  openrec: { url: 'https://www.mellow-fan.com/' }
};

const stage = document.getElementById('stage');
const stageEmpty = document.getElementById('stage-empty');
const countEl = document.getElementById('count');

let zCounter = 10;
// 浮動パネル(枠一覧/枠を追加/配置/パフォーマンス)の前面化カウンタ。掴む/フォーカスのたびに ++ して
// その要素へ与え、パネルどうしの重なり順を「最後に触ったものが最前面」にする。90000台はコンテンツ(枠)より
// 上・ツールバー/メニュー(100000台)より下の専用バンド(CSS の各パネル base z と一致させること)。
let panelZ = 90000;
let idSeq = 0;
let activeWin = null;
let masterVolume = 0; // 全体音量(0〜1)。0=無音。各枠の音量をまとめて設定する。
let restoring = true; // 復元中は saveLineup を抑止(復元の途中経過で保存データを部分上書きしないため)
const wins = [];
// 弾幕設定パネルの状態(init→wireToolbar→setupDanmakuPanel が同期実行されるため、ここ=init より前で初期化する)。
let dmkPanelWin = null; // 弾幕設定の編集対象: null=全体の既定 / win=その枠の上書き(適用先ドロップダウンで選ぶ)
const dmkPanelControls = {};   // key -> { input, valEl, revert }
let dmkPresets = [];           // 弾幕設定のプリセット [{name, settings}](MV.storage に保存・全体共有)
const DMK_PRESETS_KEY = 'mvDanmakuPresets';

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
  window.addEventListener('message', onFrameState);
  window.addEventListener('message', onTileDragMsg); // frame内長押し → タイルドラッグの中継
  window.addEventListener('message', onChatMessage); // frame からのチャット → 弾幕として流す

  // 枠の外(ステージ背景)をクリック/タップしたらフォーカス(選択・ヘッダ)を解除する。
  // 枠内クリックは e.target が枠の子要素になるので解除されない。
  stage.addEventListener('pointerdown', (e) => {
    if (e.target === stage || e.target === stageEmpty) clearSelection();
  });

  // 枠の⋮メニューを開いている時、メニュー外を pointerdown したら閉じる(外クリックで閉じる)。
  // 同時に開くメニューは1つなので、開いている枠を探して閉じるだけ。⋮ボタン/メニュー項目は stopPropagation
  // するのでここには伝わらない(=自分で開いた直後に閉じることはない)。
  // ※ 枠内 iframe(動画)上のクリックは親 document へ届かないため、そちらは window blur 側で閉じる。
  document.addEventListener('pointerdown', (e) => {
    const openWin = wins.find((w) => w.el.classList.contains('menu-open'));
    if (!openWin) return;
    if (e.target.closest('.win-menu')) return; // メニュー内のクリックは閉じない
    openWin.el.classList.remove('menu-open');
  });

  // iframe(Twitch/YouTube/OpenRec の枠やKickチャット)内のクリックは親に伝わらないので、
  // 「iframe にフォーカスが移った=その枠がクリックされた」を window blur で検知して、
  // その枠を選択しヘッダを一時表示する(タッチでもヘッダを出せるように)。
  window.addEventListener('blur', () => {
    // 枠内 iframe(動画)のクリック等でフォーカスが外れたら、開いている⋮メニューを閉じる(外クリック扱い)。
    // メニューや項目はこの document 内の要素なので、メニュー操作で blur は起きない=誤って閉じない。
    wins.forEach((w) => w.el.classList.remove('menu-open'));
    setTimeout(() => {
      const ae = document.activeElement;
      if (!ae || ae.tagName !== 'IFRAME') return;
      const win = wins.find((w) => w.el.contains(ae));
      if (win) { focusWindow(win); revealHeader(win); }
    }, 0);
  });

  const data = await MV.storage.local.get(MULTIVIEW_ACTIVE_KEY);
  const saved = data[MULTIVIEW_ACTIVE_KEY] || {};

  // 弾幕の共通(既定)設定を復元(壊れた値は dmkSanitize で弾く)。枠ごとの上書きは restoreLineup で。
  if (saved.danmakuGlobal) dmkGlobal = Object.assign({}, DMK_DEFAULTS, dmkSanitize(saved.danmakuGlobal));

  // マスタ音量を復元(無ければ 0)。窓を作る前に入れておき、各枠が最初からこの音量で開くように。
  masterVolume = clampVol(saved.masterVolume);
  syncMasterUI();

  // 新フォーマット(wins: 位置・サイズ付き)を優先して位置ごと復元。旧フォーマット(urls のみ)は
  // 初回だけ整列にフォールバック。以後は移動・リサイズのたびに保存されるので勝手に整列し直さない。
  let deferred = []; // 表示するが中身は順次読み込む枠(更新時の同時読込を避ける)
  if (Array.isArray(saved.wins) && saved.wins.length) {
    deferred = restoreLineup(saved); // マスタ音量・各枠を復元し、表示すべき枠の配列を受け取る
  } else {
    const urls = (saved.urls || []).map((u) => (u || '').trim()).filter((u) => u.length > 0).slice(0, MAX_WINDOWS);
    urls.forEach((u) => createWindow(u, { silent: true }));
    if (urls.length) tileAll(); // 旧データの初回だけ整列(以後は位置を保存・復元)
  }
  restoring = false; // 以後の移動/リサイズ/追加/削除は保存する
  updateCount();

  // 表示枠を 1 枠ずつ間隔をあけて読み込む(同時読込の 429/初期化ピーク回避)。各枠はスピナーを出して待つ。
  await loadDeferred(deferred);
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
//  - theater-state: 枠内シアター発動中 → バッジに 🎭 を出す(効いているかの確認用)。
function onFrameState(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true) return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win) return;
  if (d.type === 'adblock-state') {
    // 枠内に広告ブロッカー(別拡張の vaft)が入っているかの診断。バッジに 🛡/🚫 で出す。
    win.adblock = d.state || null;
    win.vaft = win.adblock ? win.adblock.vaft : null;
    updateWinTitle(win);
  } else if (d.type === 'danmaku-state') {
    // 'on'=チャット欄を監視中 / 'missing'=ONなのに見つからない(サイトのDOM変更の疑い) / 'off'
    win.danmakuState = d.state;
    updateWinTitle(win);
  } else if (d.type === 'theater-state') {
    win.theaterState = d.state; // 'on' | 'searching' | 'off'
    updateWinTitle(win); // バッジの 🎭/🔎 表示を更新
  } else if (d.type === 'frame-hello') {
    syncFrameTheater(win);  // 起動した frame に現在のシアター設定を返す(読込すれ違い対策)
    syncFrameDanmaku(win);  // 同じく現在の弾幕 ON/OFF も返す
  }
}

// 現在の配信ラインナップ(URL+位置・サイズ+最大化)とマスタ音量を storage に保存。
// 専用ページを開き直すと、この内容で復元される(勝手に整列し直さない)。復元中は呼ばれても抑止。
// 現在の全枠の状態(URL・位置・サイズ・音量・各種フラグ)を配列で取り出す。
// 自動保存(saveLineup)と名前付きレイアウト保存(saveLayout)で共用する。
function currentLineupItems() {
  return wins.map((w) => {
    // 縦積みモード中はタイル座標ではなく、退避してある自由配置の座標を保存する。
    const r = stackMode && w.freeRect ? w.freeRect : (w.maximized && w.prevRect ? w.prevRect : getRect(w));
    return {
      url: w.url,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
      max: !!w.maximized, vol: w.vol != null ? w.vol : 1, hidden: !!w.hidden, light: !!w.light,
      tall: w.tall == null ? null : !!w.tall, // 縦積みタイル高の手動指定(null=既定の16:9)
      span: w.span === 'half' ? 'half' : 'full', // 縦積みタイル幅(100%/50%)
      zoom: w.zoom, // 枠内サイトの縮小率の手動指定(🔍。null=幅に応じた既定)
      dmk: { on: !!w.danmaku.on, overrides: w.danmaku.overrides || {} } // 弾幕のON/OFFと枠ごと上書き設定
    };
  });
}

function saveLineup() {
  if (restoring) return;
  try {
    MV.storage.local.set({
      [MULTIVIEW_ACTIVE_KEY]: { wins: currentLineupItems(), masterVolume, danmakuGlobal: dmkGlobal, timestamp: new Date().toISOString() }
    });
  } catch (e) {
    /* noop */
  }
}

// 保存データ(saved = {wins, masterVolume})から枠を復元する。起動時の初回復元と、
// レイアウト呼び出し(applyLayout)で共用。中身(iframe/動画)はまだ読まず、表示すべき
// 枠の配列(deferred)を返すので、呼び出し側が loadDeferred で順次読み込む。
function restoreLineup(saved) {
  masterVolume = clampVol(saved.masterVolume);
  syncMasterUI();
  const deferred = [];
  (saved.wins || []).slice(0, MAX_WINDOWS).forEach((it) => {
    const url = (it.url || '').trim();
    if (!url) return;
    // 枠とレイアウトは即作るが、表示枠の中身は後で順次読む(deferLoad)。隠し枠は休止のまま。
    const win = createWindow(url, { silent: true, startHidden: !!it.hidden, light: !!it.light, deferLoad: !it.hidden });
    if (!win) return;
    if (Number.isFinite(it.vol)) setWinVol(win, it.vol);
    if (it.tall === true || it.tall === false) win.tall = it.tall;
    if (it.span === 'half') win.span = 'half';
    // 縮小率は手動指定(25〜99)のみ復元。100(等倍)は既定へ戻し、過去データに引きずられない。
    if (Number.isFinite(it.zoom) && it.zoom >= 25 && it.zoom < 100) win.zoom = it.zoom;
    if (it.dmk) {
      win.danmaku.overrides = dmkSanitize(it.dmk.overrides); // 枠ごとの上書き設定を復元(検証つき)
      win.danmaku.on = !!it.dmk.on; // ON だった枠は frame.load / frame-hello で syncFrameDanmaku が監視を再開
    }
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
  });
  if (stackMode) relayoutStack();
  return deferred;
}

// deferLoad で待たせていた表示枠を、間隔をあけて 1 枠ずつ読み込む(同時読込の 429/初期化ピーク回避)。
async function loadDeferred(deferred) {
  for (let i = 0; i < deferred.length; i++) {
    if (i > 0) await sleep(RESTORE_STAGGER_MS);
    loadWindowMedia(deferred[i]);
  }
}

// ====== レイアウト(配置プリセット)の保存・呼び出し ======
// 現在の配置を名前付きで storage に複数保存し、後から選んでその配置へ戻せるようにする。
// 自動保存(MULTIVIEW_ACTIVE_KEY)とは別キー(MULTIVIEW_LAYOUTS_KEY)で履歴を持つ。

async function listLayouts() {
  try {
    const data = await MV.storage.local.get(MULTIVIEW_LAYOUTS_KEY);
    const arr = data[MULTIVIEW_LAYOUTS_KEY];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// ISO 文字列を「6/13 14:30」形式へ。一覧の日時表示と、無名保存時の既定名に使う。
function fmtLayoutTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) {
    return '';
  }
}

// 現在の配置を名前付きで保存する。名前未指定なら日時を既定名にする。枠が無い時は保存しない。
async function saveLayout(name) {
  const items = currentLineupItems();
  if (!items.length) return null;
  const now = new Date();
  const iso = now.toISOString();
  const layout = { id: 'L' + now.getTime(), name: (name || '').trim() || fmtLayoutTime(iso), time: iso, wins: items, masterVolume };
  const layouts = await listLayouts();
  layouts.unshift(layout); // 新しいものを先頭に
  try {
    await MV.storage.local.set({ [MULTIVIEW_LAYOUTS_KEY]: layouts.slice(0, MAX_LAYOUTS) });
  } catch (e) {
    /* noop */
  }
  return layout;
}

async function deleteLayout(id) {
  const layouts = await listLayouts();
  const next = layouts.filter((l) => l.id !== id);
  try {
    await MV.storage.local.set({ [MULTIVIEW_LAYOUTS_KEY]: next });
  } catch (e) {
    /* noop */
  }
  return next;
}

// 保存済みレイアウトに戻す。今の枠を全部閉じてから、保存時の枠を作り直す。
// 配置ダイアログは実行後も閉じないため連続で押せる。loadDeferred の待ち時間中に2回目が入ると、
// 1回目の続きが「もう閉じた枠」を読み込んでしまうので、世代番号で古い呼び出しを打ち切る。
let applyLayoutGen = 0;
async function applyLayout(layout) {
  if (!layout || !Array.isArray(layout.wins)) return;
  const gen = ++applyLayoutGen;
  restoring = true; // 復元中は自動保存を抑止(途中経過で上書きしないため)
  [...wins].forEach((w) => closeWindow(w));
  const deferred = restoreLineup(layout);
  restoring = false;
  updateCount();
  saveLineup(); // 呼び出した配置を現在のラインナップとして確定保存
  renderMixer();
  if (gen !== applyLayoutGen) return; // 後から別の配置が呼ばれた → ここで降りる
  await loadDeferred(deferred);
}

// 配置ダイアログ(#layout-dialog)の開閉と、保存済み一覧の描画。
function openLayoutDialog() {
  if (stackMode) return; // スマホ(縦積み)では配置は使わない(メニューでも隠しているが念のため)
  const dlg = document.getElementById('layout-dialog');
  if (!dlg) return;
  if (dlg.classList.contains('open')) { dlg.classList.remove('open'); return; } // もう一度押したら閉じる
  const name = document.getElementById('layout-name');
  if (name) name.value = '';
  const panel = dlg.querySelector('.pos-dialog');
  centerPanel(panel);  // 開くたび中央へ(まず現在の内容で概算中央。ドラッグ後も中央から始める)
  raisePanel(dlg);     // 開いたら最前面(z は overlay 側)
  dlg.classList.add('open');
  renderLayoutList().then(() => centerPanel(panel)); // 一覧の高さが確定してから中央を微調整
}

function closeLayoutDialog() {
  const dlg = document.getElementById('layout-dialog');
  if (dlg) dlg.classList.remove('open');
}

async function renderLayoutList() {
  const list = document.getElementById('layout-list');
  if (!list) return;
  const layouts = await listLayouts();
  const sec = document.getElementById('layout-saved-sec');
  list.textContent = '';
  // 1件も無いうちは見出しごと出さない。空であることの説明も置かない(保存すれば現れるので不要)。
  if (sec) sec.hidden = !layouts.length;
  if (!layouts.length) return;
  layouts.forEach((lo) => {
    const item = document.createElement('div');
    item.className = 'layout-item';
    const main = document.createElement('button'); // 行クリックでこの配置に戻す
    main.className = 'layout-item-main';
    main.type = 'button';
    main.title = 'この配置に戻す';
    const nm = document.createElement('div');
    nm.className = 'layout-item-name';
    nm.textContent = lo.name || '(無名)';
    const meta = document.createElement('div');
    meta.className = 'layout-item-meta';
    const n = Array.isArray(lo.wins) ? lo.wins.length : 0;
    meta.textContent = n + '枠 · ' + fmtLayoutTime(lo.time);
    main.appendChild(nm);
    main.appendChild(meta);
    main.addEventListener('click', async () => { await applyLayout(lo); }); // 復元してもダイアログは閉じない(× だけで閉じる)
    const del = document.createElement('button');
    del.className = 'layout-del';
    del.type = 'button';
    del.title = 'このレイアウトを削除';
    del.textContent = '🗑';
    del.addEventListener('click', async (e) => { e.stopPropagation(); await deleteLayout(lo.id); renderLayoutList(); });
    item.appendChild(main);
    item.appendChild(del);
    list.appendChild(item);
  });
}

// ====== ウィンドウ生成 ======

function createWindow(url, opts = {}) {
  if (wins.length >= MAX_WINDOWS) return null;
  // 追加ダイアログ以外にも、保存レイアウトの復元やサイトボタンからここへ来る。対応外の URL で
  // 枠を作っても、サイト側の X-Frame-Options により中身は「接続拒否」になるだけなので、
  // どの経路から来ても作らない(空の枠が残るより、作られない方が原因が分かりやすい)。
  if (!isAllowedFrameUrl(url)) {
    console.warn('[multiview] 枠に表示できない URL のため追加しません:', url);
    return null;
  }
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

  // リサイズ用のつまみ。右下の1点だけに置き、オンマウス/一時表示のときだけ出す。
  // 隅ぴったりに置くと配信サイト側のボタン(全画面・設定・下端の再生バー)と取り合いになる。
  // クロスオリジンの iframe なので「下にサイトのボタンがあるか」は親から判定できず、いったん
  // 受け取ったポインタを iframe へ渡し直す API も無い。判定では解けないので、位置で避ける
  // (隅から少し内側へ寄せ、再生バーの上に来るようにする。量は CSS 側で調整)。
  const resizeGrip = document.createElement('div');
  resizeGrip.className = 'win-resize-grip';
  resizeGrip.dataset.dir = 'se';
  resizeGrip.title = 'ドラッグして枠の大きさを変える';
  resizeGrip.textContent = '⤡';

  // タップはサイト/プレイヤーへそのまま通す(シールドは置かない)。タイルの掴み(長押し)は
  // 枠内の content script(stream-control.js)が検知して親へ中継する(onTileDragMsg)。
  el.append(bar, body, resizeGrip);
  stage.appendChild(el);

  const win = {
    id, url, el, body, frame, video, chatFrame, chatBtn, lightBtn, bar, barX: 0, titleEl: title, volSlider,
    maximized: false, hidden: false, light: false, tall: null, span: 'full', zoom: null,
    prevRect: null, freeRect: null,
    opacity: 100, vol: 1,
    filter: { bright: 100, contrast: 100, sat: 100 },
    danmaku: { on: false, layer: null, lanes: [], overrides: {} } // コメント弾幕(層/レーンは非保存。overrides=この枠だけの上書き)
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

  // 新規枠は中央付近からカスケード(少しずつ右下へずらして)出す。全部中央に重ねると見づらいため。
  // (枠一覧/パフォーマンス等の機能パネルは中央に出す=別扱い。centerPanel)
  const NEW_W = 520, NEW_H = 320;     // 新規枠の初期サイズ
  const CAS_STEP = 34, CAS_SPAN = 6;  // 1枠ごとのずらし量 / 一巡する枠数(画面外へ伸び続けないように)
  const ci = (wins.length - 1) % CAS_SPAN;                  // この枠のカスケード位置(0〜)
  const cOff = Math.round((ci - (CAS_SPAN - 1) / 2) * CAS_STEP); // 中央を基準に左上↘右下へ均等にずらす
  const cas = {
    x: Math.max(0, Math.round((stage.clientWidth - NEW_W) / 2) + cOff),
    y: Math.max(0, Math.round((stage.clientHeight - NEW_H) / 2) + cOff),
    w: NEW_W, h: NEW_H
  };
  if (stackMode) {
    win.freeRect = cas; // 自由配置に戻った時の初期位置として保持
    relayoutStack();
  } else {
    setRect(win, cas.x, cas.y, cas.w, cas.h);
  }

  el.appendChild(buildAdjustPanel(win));

  el.addEventListener('pointerdown', (e) => {
    if (e.shiftKey && e.button === 0) { // Shift+クリック=この枠を複数選択にトグル(移動/フォーカスしない)
      e.preventDefault();
      toggleMultiSelect(win);
      revealHeader(win);
      return;
    }
    focusWindow(win);
    revealHeader(win);
  });
  // 浮かせてドラッグ: 左は長押し(タッチ対応)、右ボタン(マウス)は動かせば即つかむ=長押し不要。
  // Shift+左クリックは選択なので除外。
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2 && e.pointerType === 'mouse') { armRightDrag(win, e); return; }
    if (!(e.shiftKey && e.button === 0)) maybeStartLongPress(win, e);
  });
  // 右クリックは枠の移動に割り当てたため、枠の上ではブラウザのコンテキストメニューを出さない
  // (Android の長押しメニュー誤爆防止も兼ねる)。
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  makeBarHandle(win, bar);
  resizeGrip.addEventListener('pointerdown', (e) => beginResize(win, resizeGrip.dataset.dir, e));
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
  MV.runtime
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
  const r = getRect(win);
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
  } else if (d.type === 'tile-shift-click') {
    // frame 上での Shift+クリック → その枠を複数選択にトグル。
    const win = wins.find((w) =>
      (w.frame && w.frame.contentWindow === e.source) ||
      (w.chatFrame && w.chatFrame.contentWindow === e.source));
    if (win) { toggleMultiSelect(win); revealHeader(win); }
  } else if (d.type === 'tile-raise') {
    // frame 内で右クリック → ドラッグ前でもその枠を即最前面へ(重なりの下から出す)。
    const win = wins.find((w) =>
      (w.frame && w.frame.contentWindow === e.source) ||
      (w.chatFrame && w.chatFrame.contentWindow === e.source));
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

function focusWindow(win) {
  // 既にアクティブ(=最前面)なら z を無駄に増やさない。
  // el と bar の二重 mousedown で focusWindow が連続呼出される際の zCounter 膨張も防ぐ。
  if (activeWin === win) return;
  if (activeWin) activeWin.el.classList.remove('active');
  activeWin = win;
  win.el.classList.add('active');
  win.el.style.zIndex = ++zCounter;
  // 弾幕設定パネルが「この枠」対象で開いていれば、フォーカス先に追従して描き直す。
  const dp = document.getElementById('danmaku-panel');
  if (dp && !dp.hidden) renderDanmakuPanel(); // 開いていれば適用先ドロップダウンのラベル等を最新化
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
  // 並び替えはタイルの長押しドラッグで行うので、つまむ用ボタンは置かない([✕][⋮]の2つだけ)。
  const menuBtn = mkBtn('⋮', '', 'この枠のメニュー');
  const closeBtn = mkBtn('✕', 'q-close', '閉じる');
  // ✕ を上・⋮ を下に並べる。縦並び時、⋮メニューは下へ開くので、✕が下だとメニューに隠れて押せなくなるため。
  quick.append(closeBtn, menuBtn);

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

  // 表示・サイズ系(軽量 / 縮小 / 幅 / 高さ)。文言は syncMenuLabels が状態で更新。縮小/幅/高さは縦積み専用の
  // 効果しか持たないため、PC(自由配置)では syncMenuModeVisibility が隠す(軽量はPCでも機能するので残す)。
  if (!win.video) win.menuLight = mkToggle(() => toggleLight(win));
  if (!win.video) win.menuZoom = mkToggle(() => cycleZoom(win)); // 縮小は枠内サイト用(Kickは映像のみで不要)
  win.menuSpan = mkToggle(() => toggleSpan(win));
  win.menuTall = mkToggle(() => toggleTall(win));
  if (!win.video) win.menuDanmaku = mkToggle(() => { toggleDanmaku(win); saveLineup(); }); // 💬 弾幕。on は永続なので保存(Kickは対象外)
  if (!win.video) mkItem('⚙ 弾幕の設定', () => openDanmakuPanel(win)); // この枠を対象に設定パネルを開く
  mkSep();
  // 操作系。
  mkItem('⛶ 全画面で操作', () => toggleStackMax(win));
  if (win.chatFrame) mkItem('💬 チャット表示切替', () => toggleChat(win));
  mkItem('🎨 映像調整', () => toggleAdjust(win));
  mkItem('🔄 再読込', () => reloadWindow(win));
  mkItem('↗ 元サイトを新タブ', () => openOriginal(win));
  syncMenuLabels(win);
  syncMenuModeVisibility(win); // PC(自由配置)では幅/高さ/縮小を隠す(縦積みでのみ効くため)

  // ⋮ は pointerdown で確定(タッチの合成 click が下の iframe へ漏れるのを防ぐ。反応も速い)。
  menuBtn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const willOpen = !win.el.classList.contains('menu-open');
    // ⋮メニューは同時に1つだけ。開く前に全枠(自分含む)の menu-open を外す。
    // (🎨パネルの toggleAdjust と同じ方針。別の枠で開きっぱなしの2枚目ができるのを防ぐ)
    wins.forEach((w) => w.el.classList.remove('menu-open'));
    revealHeader(win); // メニュー操作中は隠さない
    if (willOpen) {
      // この枠を最前面へ。⋮メニューは枠のスタッキング文脈内にあるため、枠が最前面でないと
      // メニュー(z:100001)も枠ごと他の動画枠の下に沈む。前面化で常に他枠より上に出す。
      focusWindow(win);
      win.el.classList.add('menu-open');
      positionWinMenu(menuBtn, menu); // 画面外へはみ出さないよう配置
    }
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
// PC(自由配置)では「幅・高さ・縮小」は実質無効/非推奨なので枠メニューから隠す(縦積みでのみ意味を持つ)。
// 軽量はPCでも機能するので残す。モードは実行中に切り替わりうる(タブレット等)ため、メニュー生成時と
// updateStackMode の両方から呼んで追従させる。
function syncMenuModeVisibility(win) {
  for (const m of [win.menuSpan, win.menuTall, win.menuZoom]) {
    if (m) m.btn.style.display = stackMode ? '' : 'none';
  }
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
  if (win.menuDanmaku) {
    win.menuDanmaku.name.textContent = '💬 弾幕';
    win.menuDanmaku.val.textContent = win.danmaku.on ? 'ON' : 'OFF';
    win.menuDanmaku.btn.classList.toggle('on', win.danmaku.on);
    win.menuDanmaku.btn.title = 'チャットのコメントを画面に流す(タップで ' + (win.danmaku.on ? 'OFF' : 'ON') + ')';
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

// ====== コメント弾幕 ======
// 各枠の content script(stream-control.js)がチャットDOMから拾ったコメントを postMessage で送ってくる。
// ここでは枠ごとにオーバーレイ層(.win-danmaku)を重ね、DOM要素+WAAPI で右→左へ流す。レーン(行)を
// 割り当て、前の弾幕が十分先へ進んだ行にだけ次を出して重なりを避ける。OFF の枠・隠し枠には流さない。

function onChatMessage(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true || d.type !== 'chat-message') return;
  // 入れ子フレーム(YouTube live_chat)のコメントは枠フレームが中継するので、e.source は枠フレーム本体。
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win || !win.danmaku.on || win.hidden) return;
  // parts(テキスト/絵文字画像のセグメント配列)。旧 text 形式が来ても一応扱える。
  const parts = Array.isArray(d.parts) ? d.parts : (d.text ? [{ text: String(d.text) }] : []);
  spawnDanmaku(win, parts, d.color || '');
}

// 枠に弾幕オーバーレイ層を用意(無ければ作る)。映像と同座標で、CSS filter の影響を受けない位置に置く。
function ensureDanmakuLayer(win) {
  if (win.danmaku.layer && win.danmaku.layer.isConnected) return win.danmaku.layer;
  const parentEl = win.video ? (win.body.querySelector('.win-media') || win.body) : win.body;
  const layer = document.createElement('div');
  layer.className = 'win-danmaku';
  parentEl.appendChild(layer);
  win.danmaku.layer = layer;
  win.danmaku.lanes = [];
  return layer;
}
function clearDanmakuLayer(win) {
  if (win.danmaku.layer) { try { win.danmaku.layer.remove(); } catch (e) { /* noop */ } }
  win.danmaku.layer = null;
  win.danmaku.lanes = [];
}

// 枠の実効設定 = 全体の既定(dmkGlobal)に、その枠の上書き(overrides)を重ねたもの。
function dmkSettings(win) {
  return Object.assign({}, dmkGlobal, (win && win.danmaku && win.danmaku.overrides) || {});
}
// この枠の実効設定が全体の既定と1つでも違うか(↺・●・解除ボタンの出し分けに使う。
// 「overrides にキーがあるか」ではなく「実際に値が違うか」で見る=全体と同値の上書きは個別扱いしない)。
function dmkHasDiff(win) {
  if (!win || !win.danmaku) return false;
  const eff = dmkSettings(win);
  return DMK_CONTROLS.some((c) => eff[c.key] !== dmkGlobal[c.key]);
}
// 色文字列(#rgb / #rrggbb / rgb()) を [r,g,b] に。失敗は null。
function dmkParseColor(c) {
  if (!c) return null;
  c = String(c).trim();
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) { return m[1].split('').map((h) => parseInt(h + h, 16)); }
  m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(',').map((x) => parseInt(x, 10)); if (p.length >= 3 && p.every((v) => !isNaN(v))) return [p[0], p[1], p[2]]; }
  return null;
}
// ユーザー色を白とブレンド(strength 0=白 / 100=原色)。取れなければ白。
function dmkBlendColor(color, strength) {
  const rgb = dmkParseColor(color);
  if (!rgb) return '#fff';
  const t = Math.max(0, Math.min(100, strength)) / 100;
  const mix = (v) => Math.round(255 * (1 - t) + v * t);
  return 'rgb(' + mix(rgb[0]) + ',' + mix(rgb[1]) + ',' + mix(rgb[2]) + ')';
}

// 空いているレーン番号を返す(前の弾幕の末尾が GAP 以上左へ進んだ行)。laneH は枠の実効サイズで決まる。
function pickDanmakuLane(win, layerH, laneH) {
  const laneCount = Math.max(1, Math.floor(layerH / laneH));
  const lanes = win.danmaku.lanes;
  const now = performance.now();
  for (let i = 0; i < laneCount; i++) {
    const ln = lanes[i];
    if (!ln) return i; // 未使用の行
    const traveled = ((now - ln.start) / 1000) * ln.speed; // 前の弾幕が左へ進んだ距離
    if (traveled >= ln.width + DMK_GAP) return i;           // 末尾が十分先=この行は空き
  }
  return -1;
}

// parts(テキスト/絵文字画像)からノードの中身を組み立てる。絵文字は <img> で描画(https のみ・枚数上限)。
function dmkBuildNode(node, parts, fontSize) {
  let textLen = 0, imgs = 0;
  for (const p of parts) {
    if (p && p.text != null) {
      let t = String(p.text);
      if (textLen + t.length > 200) t = t.slice(0, 200 - textLen);
      if (t) { node.appendChild(document.createTextNode(t)); textLen += t.length; }
    } else if (p && p.img && imgs < 24) {
      const src = String(p.img);
      if (!/^https:\/\//i.test(src)) continue; // https の画像のみ(安全)
      const img = document.createElement('img');
      img.className = 'dmk-emote';
      img.src = src;
      img.alt = p.alt || '';
      img.referrerPolicy = 'no-referrer';
      img.style.height = Math.round(fontSize * 1.25) + 'px'; // 行内に収まる絵文字サイズ
      node.appendChild(img);
      imgs++;
    }
    if (textLen >= 200) break;
  }
}

function spawnDanmaku(win, parts, color) {
  if (!win.danmaku.on || win.hidden || !parts || !parts.length) return;
  const layer = ensureDanmakuLayer(win);
  const layerW = layer.clientWidth, layerH = layer.clientHeight;
  if (!layerW || !layerH) return;
  if (layer.childElementCount >= DMK_MAX_NODES) return; // 暴発保険
  const s = dmkSettings(win);
  // 長さ(テキスト+絵文字alt)で 長文縮小・速度 を決める
  let plain = '';
  for (const p of parts) plain += (p && p.text != null ? p.text : (p && p.alt) || '');
  const len = plain.length || 1;
  // 長文を縮小: しきい値を超えると長いほど小さく(荒らし長文を見づらく)
  let scale = 1;
  if (s.longShrink && len > s.longShrinkThreshold) scale = Math.max(DMK_MIN_SCALE, s.longShrinkThreshold / len);
  const fontSize = Math.max(8, Math.round(s.fontSize * scale));
  const laneH = Math.round(s.fontSize * 1.4); // 行高は基準サイズで固定(縮小ノードも同じ行に収まる)
  // 長さで速度: 長いほど速く流す
  let speed = s.speed;
  if (s.speedByLength) speed = Math.round(s.speed * Math.min(DMK_SPEED_MAX_FACTOR, Math.max(1, len / DMK_SPEED_REF_LEN)));
  // 色: 使う設定 かつ 色が取れたらブレンド、それ以外は白
  const col = (s.useColor && color) ? dmkBlendColor(color, s.colorStrength) : '#fff';

  const node = document.createElement('div');
  node.className = 'dmk';
  node.style.color = col;
  node.style.fontSize = fontSize + 'px';
  node.style.lineHeight = laneH + 'px';
  dmkBuildNode(node, parts, fontSize); // テキスト+絵文字画像を組み立て
  if (!node.childNodes.length) return; // 中身が無ければ出さない
  node.style.visibility = 'hidden'; // 幅計測のため一旦不可視で配置(レイアウトは効く)
  layer.appendChild(node);
  layer.style.opacity = s.opacity / 100; // 設定変更も都度反映
  // 絵文字画像は非同期ロードのため、幅を正しく測るには decode を待つ必要がある。
  // 画像があれば decode 完了(or 800ms 打ち切り)後に流す。テキストのみなら即流す。
  const imgs = node.getElementsByTagName('img');
  if (imgs.length) {
    Promise.race([
      Promise.all(Array.prototype.map.call(imgs, (im) => im.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, 800))
    ]).then(() => dmkLaunchNode(win, node, layer, layerW, laneH, speed));
  } else {
    dmkLaunchNode(win, node, layer, layerW, laneH, speed);
  }
}

// 計測→レーン割当→右→左アニメ。絵文字画像の decode 待ちの後に呼ばれることがあるので、
// 既に枠が消えている/中身が無いケースに備えて防御する。
function dmkLaunchNode(win, node, layer, layerW, laneH, speed) {
  if (!node.isConnected || !win.danmaku.on) { try { node.remove(); } catch (e) { /* noop */ } return; }
  const layerH = layer.clientHeight;
  const nodeW = node.offsetWidth;
  const lane = pickDanmakuLane(win, layerH, laneH);
  if (lane < 0) { node.remove(); return; } // 空き行が無ければ捨てる(重なり防止)
  node.style.top = (lane * laneH) + 'px';
  node.style.visibility = '';
  win.danmaku.lanes[lane] = { start: performance.now(), width: nodeW, speed };
  const dur = ((layerW + nodeW) / speed) * 1000;
  const anim = node.animate(
    [{ transform: 'translateX(' + layerW + 'px)' }, { transform: 'translateX(' + (-nodeW) + 'px)' }],
    { duration: dur, easing: 'linear' }
  );
  const done = () => { try { node.remove(); } catch (e) { /* noop */ } };
  anim.onfinish = done;
  anim.oncancel = done;
}

// 枠ごとの弾幕 ON/OFF(⋮メニューから)。ON で層を用意し、子(content script)へ監視開始/停止を伝える。
function toggleDanmaku(win) {
  win.danmaku.on = !win.danmaku.on;
  if (win.danmaku.on) ensureDanmakuLayer(win);
  else clearDanmakuLayer(win);
  sendDanmakuEnabled(win, win.danmaku.on);
  syncMenuLabels(win);
}
function sendDanmakuEnabled(win, on) {
  if (!win.frame) return; // Kick(<video>)はチャット取得対象外
  try {
    win.frame.contentWindow.postMessage({ [MAGIC]: true, type: 'set-danmaku-enabled', value: !!on }, '*');
  } catch (e) { /* noop */ }
}
// frame の読込/挨拶のすれ違い対策。現在の弾幕状態を frame へ送り直す(theater と同型)。
function syncFrameDanmaku(win) {
  sendDanmakuEnabled(win, win.danmaku.on);
}

// 保存値の検証: 既知キーだけを範囲内に収めて取り込む(壊れた storage 値で暴れない)。
function dmkSanitize(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  DMK_CONTROLS.forEach((c) => {
    if (!(c.key in o)) return;
    if (c.type === 'toggle') out[c.key] = !!o[c.key];
    else { const v = Number(o[c.key]); if (Number.isFinite(v)) out[c.key] = Math.max(c.min, Math.min(c.max, Math.round(v))); }
  });
  return out;
}

// ====== 弾幕設定パネル(全体の既定 / この枠の上書き) ======
// 状態(dmkPanelWin / dmkPanelControls)は init より前で初期化済み(ファイル先頭)。

// 編集を反映先へ書き込む。global なら dmkGlobal、win なら activeWin.danmaku.overrides。
function dmkEditValue(key, value) {
  if (dmkPanelWin) {
    dmkPanelWin.danmaku.overrides = dmkPanelWin.danmaku.overrides || {};
    dmkPanelWin.danmaku.overrides[key] = value;
  } else {
    dmkGlobal[key] = value;
  }
  applyDanmakuSettings();
}
// 不透明度など即時に見た目へ反映すべき設定を各層へ当てる(速度・色・サイズ等は次の弾幕から効く)。
function applyDanmakuSettings() {
  wins.forEach((w) => { if (w.danmaku.layer) w.danmaku.layer.style.opacity = dmkSettings(w).opacity / 100; });
}
// 適用先ドロップダウンの選択肢を「全体の既定 + 弾幕対象の各枠(Kick以外)」で作り直し、現在の対象を選択。
// 個別設定のある枠には ● を付けて分かるようにする。対象枠が閉じられていたら全体へ戻す。
function populateDmkScope() {
  const sel = document.getElementById('dmk-scope');
  if (!sel) return;
  const want = dmkPanelWin ? String(dmkPanelWin.id) : 'global';
  sel.innerHTML = '';
  const og = document.createElement('option');
  og.value = 'global'; og.textContent = '全体の既定';
  sel.appendChild(og);
  wins.filter((w) => !w.video).forEach((w) => {
    const o = document.createElement('option');
    o.value = String(w.id);
    o.textContent = winLabel(w) + (dmkHasDiff(w) ? ' ●' : ''); // ● = 全体と違う個別設定あり
    sel.appendChild(o);
  });
  sel.value = want;
  if (sel.value !== want) { dmkPanelWin = null; sel.value = 'global'; } // 対象枠が消えていた
}
// 値に一番近い段階のインデックスを返す。
function nearestStepIndex(steps, value) {
  const v = Number(value);
  let best = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - v) < Math.abs(steps[best] - v)) best = i;
  }
  return best;
}

// パネルの各コントロールを現在の対象(全体の既定 or その枠の実効値)に合わせて描き直す。
function renderDanmakuPanel() {
  if (dmkPanelWin && !wins.includes(dmkPanelWin)) dmkPanelWin = null; // 閉じられた枠は全体へ
  const src = dmkPanelWin ? dmkSettings(dmkPanelWin) : dmkGlobal;
  DMK_CONTROLS.forEach((c) => {
    const ui = dmkPanelControls[c.key];
    if (!ui) return;
    if (c.type === 'toggle') {
      const on = !!src[c.key];
      ui.input.classList.toggle('on', on);
      ui.input.textContent = on ? 'ON' : 'OFF';
    } else if (ui.steps) {
      // 保存値が段階とぴったり一致しないこと(旧設定・プリセット)もあるので、一番近い段階に寄せる。
      const i = nearestStepIndex(ui.steps, src[c.key]);
      ui.input.value = String(i);
      ui.input.title = ui.stepNames[i];
    } else {
      ui.input.value = src[c.key];
      ui.valEl.textContent = src[c.key] + (c.unit || '');
    }
    if (ui.revert) ui.revert.classList.toggle('is-hidden', !(dmkPanelWin && src[c.key] !== dmkGlobal[c.key])); // 全体と実際に違う項目だけ ↺ を可視化(場所は常に確保)
  });
  populateDmkScope();
  renderDmkOnOff();
  const resetBtn = document.getElementById('dmk-reset');
  if (resetBtn) {
    if (dmkPanelWin) { // 枠: 全体と違う設定がある時だけ「解除」を出す
      resetBtn.textContent = 'この枠の個別設定を解除';
      resetBtn.hidden = !dmkHasDiff(dmkPanelWin);
    } else { // 全体: いつでも初期値へ戻せる
      resetBtn.textContent = '初期値に戻す';
      resetBtn.hidden = false;
    }
  }
}
// 適用先に応じた弾幕 ON/OFF。枠選択中=その枠のトグル / 全体=全枠まとめて ON/OFF。
function renderDmkOnOff() {
  const box = document.getElementById('dmk-onoff');
  if (!box) return;
  box.innerHTML = '';
  if (dmkPanelWin) {
    const label = document.createElement('span');
    label.className = 'dmk-onoff-label';
    label.textContent = 'この枠の弾幕';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dmk-toggle';
    const on = !!dmkPanelWin.danmaku.on;
    btn.classList.toggle('on', on);
    btn.textContent = on ? 'ON' : 'OFF';
    btn.addEventListener('click', () => { toggleDanmaku(dmkPanelWin); renderDanmakuPanel(); saveLineup(); });
    box.append(label, btn);
  } else {
    const label = document.createElement('span');
    label.className = 'dmk-onoff-label';
    label.textContent = '弾幕(全枠)';
    const onBtn = document.createElement('button');
    onBtn.type = 'button'; onBtn.className = 'dmk-bulk'; onBtn.textContent = 'すべてON';
    onBtn.addEventListener('click', () => setAllDanmaku(true));
    const offBtn = document.createElement('button');
    offBtn.type = 'button'; offBtn.className = 'dmk-bulk'; offBtn.textContent = 'すべてOFF';
    offBtn.addEventListener('click', () => setAllDanmaku(false));
    box.append(label, onBtn, offBtn);
  }
}
function setAllDanmaku(on) {
  wins.filter((w) => !w.video).forEach((w) => { if (!!w.danmaku.on !== on) toggleDanmaku(w); });
  saveLineup();
}
// プリセット: 現在の適用先の実効値を名前付きで保存し、選んで適用/削除(MV.storage で全体共有)。
function renderDmkPresets() {
  const sel = document.getElementById('dmk-preset-sel');
  if (!sel) return;
  sel.innerHTML = '';
  if (!dmkPresets.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '(プリセットなし)';
    sel.appendChild(o);
    return;
  }
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = '(選択)';
  sel.appendChild(o0);
  dmkPresets.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = p.name;
    sel.appendChild(o);
  });
}
function saveDmkPresets() {
  try { MV.storage.local.set({ [DMK_PRESETS_KEY]: dmkPresets }); } catch (e) { /* noop */ }
}
function dmkPresetSave() {
  const name = (window.prompt('プリセット名', '') || '').trim();
  if (!name) return;
  const src = dmkPanelWin ? dmkSettings(dmkPanelWin) : dmkGlobal;
  dmkPresets.push({ name: name.slice(0, 40), settings: dmkSanitize(src) });
  saveDmkPresets();
  renderDmkPresets();
  document.getElementById('dmk-preset-sel').value = String(dmkPresets.length - 1);
}
function dmkPresetApply() {
  const sel = document.getElementById('dmk-preset-sel');
  if (sel.value === '') return; // プレースホルダ「(選択)」時は何もしない(Number('')===0 で先頭に誤爆するため)
  const p = dmkPresets[Number(sel.value)];
  if (!p) return;
  const s = dmkSanitize(p.settings);
  if (dmkPanelWin) {
    // 枠: プリセット値のうち「全体と違うもの」だけ上書きにする(同値は上書きにせず全体に追従=↺/●を出さない)。
    const ovr = {};
    DMK_CONTROLS.forEach((c) => { if (c.key in s && s[c.key] !== dmkGlobal[c.key]) ovr[c.key] = s[c.key]; });
    dmkPanelWin.danmaku.overrides = ovr;
  } else {
    dmkGlobal = Object.assign({}, DMK_DEFAULTS, s); // 全体: 既定へプリセットを重ねる
  }
  applyDanmakuSettings();
  renderDanmakuPanel();
  saveLineup();
}
function dmkPresetDelete() {
  const sel = document.getElementById('dmk-preset-sel');
  if (sel.value === '') return; // プレースホルダ時は何もしない(Number('')===0 で先頭を消してしまうため)
  const i = Number(sel.value);
  if (!dmkPresets[i]) return;
  dmkPresets.splice(i, 1);
  saveDmkPresets();
  renderDmkPresets();
}
// パネルを開く。win 指定ありなら適用先=その枠(フォーカスもする)、なしなら全体の既定。
function openDanmakuPanel(win) {
  const panel = document.getElementById('danmaku-panel');
  if (!panel) return;
  // 全体対象で開く操作(ツールバー / ≡メニュー)は、表示中にもう一度押したら閉じる。
  // 枠を指定して開くときは対象を切り替えたいので、開いたままにする。
  if (!win && !panel.hidden) { panel.hidden = true; return; }
  dmkPanelWin = (win && !win.video) ? win : null; // Kick は弾幕対象外なので全体扱い
  if (win) focusWindow(win);
  panel.hidden = false;
  raisePanel(panel);
  centerPanel(panel);
  renderDanmakuPanel();
}
// 設定1行(ラベル + つまみ/トグル + ↺)を組み立てて返す。簡易と詳細の両方から使う。
function buildDmkRow(c) {
  {
    const row = document.createElement('div');
    row.className = 'dmk-row';
    const label = document.createElement('span');
    label.className = 'dmk-label';
    label.textContent = c.label;
    row.appendChild(label);
    let ctrl;
    if (c.type === 'toggle') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dmk-toggle';
      btn.addEventListener('click', () => {
        const cur = dmkPanelWin ? dmkSettings(dmkPanelWin) : dmkGlobal;
        dmkEditValue(c.key, !cur[c.key]);
        renderDanmakuPanel();
        saveLineup();
      });
      row.appendChild(btn);
      ctrl = { input: btn };
    } else if (c.steps) {
      // 段階選択。つまみは 0..n-1 のインデックスを動かし、値は steps から引く。
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0'; input.max = String(c.steps.length - 1); input.step = '1';
      // list を付けると Chrome がつまみの下に目盛りを描く(段階があることが見て分かる)。
      const ticks = document.createElement('datalist');
      ticks.id = 'dmk-ticks-' + c.key;
      c.steps.forEach((_, i) => { const o = document.createElement('option'); o.value = String(i); ticks.appendChild(o); });
      input.setAttribute('list', ticks.id);
      // 段階名は表示しない(つまみの幅を削るため)。目盛りと位置で分かるので、名前はツールチップに回す。
      input.addEventListener('input', () => {
        const i = Number(input.value);
        dmkEditValue(c.key, c.steps[i]);
        input.title = c.stepNames[i];
      });
      input.addEventListener('change', () => { saveLineup(); renderDanmakuPanel(); });
      row.append(input, ticks);
      ctrl = { input, steps: c.steps, stepNames: c.stepNames };
    } else {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(c.min); input.max = String(c.max);
      const val = document.createElement('span');
      val.className = 'dmk-val';
      input.addEventListener('input', () => {
        dmkEditValue(c.key, Number(input.value));
        val.textContent = input.value + (c.unit || '');
      });
      input.addEventListener('change', () => { saveLineup(); renderDanmakuPanel(); }); // 離したら保存 + ↺/● を更新
      row.append(input, val);
      ctrl = { input, valEl: val };
    }
    // ↺ 個別リセット: この枠の上書きを1項目だけ全体へ戻す。上書き中のときだけ表示(render で出し分け)。
    const rev = document.createElement('button');
    rev.type = 'button';
    rev.className = 'dmk-revert';
    rev.textContent = '↺';
    rev.title = 'この項目を全体の値に戻す';
    rev.classList.add('is-hidden'); // 既定は不可視(場所は確保=つまみ幅を固定)
    rev.addEventListener('click', () => {
      if (dmkPanelWin && dmkPanelWin.danmaku.overrides) {
        delete dmkPanelWin.danmaku.overrides[c.key];
        applyDanmakuSettings();
        renderDanmakuPanel();
        saveLineup();
      }
    });
    row.appendChild(rev);
    ctrl.revert = rev;
    dmkPanelControls[c.key] = ctrl;
    return row;
  }
}

function setupDanmakuPanel() {
  const panel = document.getElementById('danmaku-panel');
  if (!panel) return;
  const rows = panel.querySelector('.dmk-rows');

  // 簡易: 普段いじる項目だけを、種類の見出しなしで並べる(最初の見た目を軽くする)。
  DMK_CONTROLS.filter((c) => !c.adv).forEach((c) => rows.appendChild(buildDmkRow(c)));

  // 詳細: 既定は畳んでおき、開いたときだけ種類ごとの見出し付きで出す。
  const advWrap = document.createElement('div');
  advWrap.className = 'dmk-adv';
  const advBtn = document.createElement('button');
  advBtn.type = 'button';
  advBtn.className = 'dmk-adv-toggle';
  const advBody = document.createElement('div');
  advBody.className = 'dmk-adv-body';
  advBody.hidden = true;
  const syncAdvBtn = () => { advBtn.textContent = advBody.hidden ? '詳細設定 ▾' : '詳細設定 ▴'; };
  syncAdvBtn();
  advBtn.addEventListener('click', () => { advBody.hidden = !advBody.hidden; syncAdvBtn(); });
  let curGroup = null;
  DMK_CONTROLS.filter((c) => c.adv).forEach((c) => {
    if (c.group && c.group !== curGroup) { // 種類ごとの見出し(サイズ/速度/色/表示)
      curGroup = c.group;
      const h = document.createElement('div');
      h.className = 'dmk-group';
      h.textContent = c.group;
      advBody.appendChild(h);
    }
    advBody.appendChild(buildDmkRow(c));
  });
  // プリセットも詳細側へ移す。常時見えている必要は無く、簡易表示を軽くする。
  const presets = panel.querySelector('.dmk-presets');
  if (presets) advBody.appendChild(presets);
  advWrap.append(advBtn, advBody);
  rows.insertAdjacentElement('afterend', advWrap);

  const scope = document.getElementById('dmk-scope');
  if (scope) scope.addEventListener('change', () => {
    dmkPanelWin = scope.value === 'global' ? null : (wins.find((w) => String(w.id) === scope.value) || null);
    renderDanmakuPanel();
  });
  document.getElementById('dmk-reset').addEventListener('click', () => {
    if (dmkPanelWin) { dmkPanelWin.danmaku.overrides = {}; } // 枠: 個別設定を全解除(全体に追従)
    else { dmkGlobal = Object.assign({}, DMK_DEFAULTS); }    // 全体: 初期値へ
    applyDanmakuSettings();
    renderDanmakuPanel();
    saveLineup();
  });
  document.getElementById('dmk-preset-apply').addEventListener('click', dmkPresetApply);
  document.getElementById('dmk-preset-save').addEventListener('click', dmkPresetSave);
  document.getElementById('dmk-preset-del').addEventListener('click', dmkPresetDelete);
  try {
    MV.storage.local.get(DMK_PRESETS_KEY, (r) => {
      const arr = r && r[DMK_PRESETS_KEY];
      if (!Array.isArray(arr)) { renderDmkPresets(); return; }
      const loaded = arr.filter((p) => p && p.name)
        .map((p) => ({ name: String(p.name).slice(0, 40), settings: dmkSanitize(p.settings) }));
      // 読込を待たずにユーザーが保存していることがある。丸ごと代入すると、その追加分が
      // 画面から消え(storage には残るので次回起動で復活し)挙動が不可解になる。
      // 既にメモリ上にある名前を優先し、保存済みのうち未知のものだけを足す。
      const known = new Set(dmkPresets.map((p) => p.name));
      dmkPresets = dmkPresets.concat(loaded.filter((p) => !known.has(p.name)));
      renderDmkPresets();
    });
  } catch (e) { renderDmkPresets(); }
  document.getElementById('danmaku-close').addEventListener('click', () => { panel.hidden = true; });
  makePanelDraggable(panel, panel.querySelector('.dmk-head'));
  wirePanelRaise(panel); // 掴む/フォーカスで最前面
  const openBtn = document.getElementById('danmaku-settings-btn');
  if (openBtn) openBtn.addEventListener('click', () => openDanmakuPanel(null));
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

// 選択(アクティブ枠・ヘッダ表示・⋮メニュー・複数選択)をすべて解除する。
function clearSelection() {
  if (activeWin) activeWin.el.classList.remove('active');
  activeWin = null;
  wins.forEach((w) => { w.el.classList.remove('show-bar', 'adjust-open', 'menu-open'); clearTimeout(w.barTimer); });
  clearMultiSelect();
}

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
      if (!slideMode) saveLineup(); // 枠を動かしたら位置を保存(スライドのみのときは保存しない)
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
  }, () => saveLineup()); // リサイズ後のサイズ・位置を保存
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
// 🍪 ログインCookie ダイアログ。切り替えと「元に戻す」を置く。
// 枠内のログインは対象サイトの Cookie の SameSite 変更に依存し、その変更はブラウザ全体へ効く。
// 黙って変えるのではなく、利用者が選べて戻せる状態にしておく。
function openCookieDialog() {
  const dlg = document.getElementById('cookie-dialog');
  if (!dlg) return;
  if (dlg.classList.contains('open')) { dlg.classList.remove('open'); return; } // もう一度押したら閉じる
  document.getElementById('cookie-relax').checked = cookieRelaxOn;
  document.getElementById('cookie-status').textContent = '';
  const panel = dlg.querySelector('.pos-dialog');
  centerPanel(panel); // 他のダイアログと同じく、開くたび中央へ置き直す
  raisePanel(dlg);
  dlg.classList.add('open');
}

function setupCookieDialog() {
  const dlg = document.getElementById('cookie-dialog');
  if (!dlg) return;
  const close = () => dlg.classList.remove('open');
  document.getElementById('cookie-dialog-close').addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });

  const toggle = document.getElementById('cookie-relax');
  toggle.addEventListener('change', () => {
    cookieRelaxOn = toggle.checked;
    MV.storage.local.set({ [COOKIE_RELAX_KEY]: cookieRelaxOn });
    document.getElementById('cookie-status').textContent = cookieRelaxOn
      ? 'ON にしました。次に枠を読み込むときから適用されます。'
      : 'OFF にしました。以後は Cookie に触れません(既に変更したぶんは下のボタンで戻せます)。';
  });

  const status = document.getElementById('cookie-status');
  const restoreBtn = document.getElementById('cookie-restore');
  restoreBtn.addEventListener('click', async () => {
    restoreBtn.disabled = true;
    status.textContent = '戻しています…';
    try {
      const resp = await MV.runtime.sendMessage({ type: 'restore-cookies' });
      status.textContent = resp && resp.ok
        ? `${resp.restored} 件の Cookie を元の設定に戻しました。枠を読み込み直すと反映されます。`
        : '戻せませんでした。';
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

function loadFrameWithLogin(frameEl, domain, src) {
  if (!cookieRelaxOn) { frameEl.src = src; return; } // OFF なら Cookie に触れない(未ログイン表示になる)
  MV.runtime
    .sendMessage({ type: 'relax-cookies', domains: [domain] })
    .then(() => { frameEl.src = src; })
    .catch(() => { frameEl.src = src; }); // 失敗しても一応読み込む
}

// 埋め込み内でログインを使いたいサイトの cookie 緩和対象ドメインを返す(対象外は null)。
// YouTube は埋め込みログインの仕組みが別で、緩和がむしろ逆効果になりうるため対象にしない。
function loginDomainOf(host) {
  if (host.includes('twitch.tv')) return 'twitch.tv';
  if (host.includes('mellow-fan.com')) return 'mellow-fan.com';
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
    syncFrameTheater(win);  // シアター有効化(+全画面中なら一時停止)を伝える
    syncFrameDanmaku(win);  // 弾幕 ON 中なら再読込後も監視を再開させる
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
    MV.tabs.create({ url: win.url });
  } catch (e) {
    window.open(win.url, '_blank', 'noopener');
  }
}

function closeWindow(win) {
  // 遅延読み込み待ちのまま閉じられた枠を、あとから loadWindowMedia が読み込んでしまうのを防ぐ。
  // Kick 枠だと破棄できない Hls インスタンスが生まれ、タブを閉じるまでセグメント取得が続く
  // (この枠は既に wins から外れるので closeWindow の destroy は二度と走らない)。
  win.pendingLoad = false;
  clearStackMax(win); // 全画面のまま閉じても body の状態を残さない
  hideWinLoading(win); // 読み込み待ち中に閉じてもスピナー/保険タイマーを残さない
  selectedWins.delete(win); // 複数選択に残さない
  // 確認済みの Chromium バグ crbug.com/371871759 への対処(我々のコードの不具合ではない)。
  // 同一サイトの枠はサイト分離で1プロセスに同居し、音声出力デバイス(シンク)を共有する。修正前の
  // Chromium はその共有シンクを「最初にシンクを作ったサブフレーム」に束縛するため、それ(=同サイトで
  // 最初の枠)を閉じるとシンクごと落ち、残りの同サイト枠が無音になる(映像は続く/リロードでしか戻らない)。
  // M132 のコミット f93860fac35e でシンクをメインフレームに束縛して修正されたが、その条件は
  // main_frame_token.Is<LocalFrameToken>()(=メインフレームが同一プロセス)のときだけ。本拡張のメイン
  // フレームは chrome-extension:// ページで Twitch 枠とは別プロセス=リモート扱いのため条件を満たさず、
  // 最新 Chrome でも依然オーナー(最初の枠)束縛のまま再発する。よって自前で復帰させる:
  // 閉じる枠がそのオーナーなら、残りの同サイト枠を作り直してシンクを再生成し音を復帰させる(下の remount)。
  // 2つ目以降(非オーナー)を閉じる時は何もしない。詳細根拠はメモリ audio-sink-first-frame-bug.md 参照。
  const closedHost = hostOf(win.url);
  const closedIdx = wins.indexOf(win);
  const sameSiteSurvivors = wins.filter((w) => w !== win && w.frame && hostOf(w.url) === closedHost);
  const wasSinkOwner = sameSiteSurvivors.length > 0 && sameSiteSurvivors.every((w) => wins.indexOf(w) > closedIdx);
  if (closedIdx >= 0) wins.splice(closedIdx, 1);
  if (win.video && win.video._hls) {
    try { win.video._hls.destroy(); } catch (e) { /* noop */ }
  }
  win.el.remove();
  if (activeWin === win) {
    activeWin = null;
    // アクティブ窓を閉じたら、残っている最前面寄りの窓へフォーカスを引き継ぐ。
    if (wins.length) focusWindow(wins[wins.length - 1]);
  }
  if (dmkPanelWin === win) { // 弾幕設定の対象枠を閉じた → 全体へ戻す(非アクティブ/最後の枠でも取りこぼさない)
    dmkPanelWin = null;
    const dp = document.getElementById('danmaku-panel');
    if (dp && !dp.hidden) renderDanmakuPanel();
  }
  if (stackMode) relayoutStack(); // 縦積みでは閉じた直後に残りのタイルを詰め直す(hideWindow と同じ。隙間を残さない)
  updateCount();
  saveLineup();
  renderMixer();
  if (wasSinkOwner) {
    // 共有シンクのオーナー枠を閉じた → 残りの同サイト枠を作り直して音声を復帰(=手動リロードの自動化)。
    setTimeout(() => { sameSiteSurvivors.forEach((w) => { if (wins.indexOf(w) >= 0) remountFrame(w); }); }, 150);
  }
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
  // 非表示でも音は止めない(👁は見た目を消すだけ)。実音量 = 枠ごと音量 × マスタ。
  const eff = Math.max(0, Math.min(1, (win.vol != null ? win.vol : 1) * v));
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

// 枠を「隠す/表示する」。見た目を消すだけで、再生も音も止めない(再マウントもしない)。
// 位置・サイズ・URLは保持。起動時に未読込で復元された枠だけ、初回表示時に resumeMedia で読み込む。
function hideWindow(win) {
  clearStackMax(win);
  win.hidden = true;
  win.el.style.display = 'none'; // メディアはそのまま(再生・音・通信を継続)
  if (stackMode) relayoutStack(); // 空いた分を詰める
  renderMixer();
  saveLineup();
}
function showWindow(win) {
  win.hidden = false;
  win.el.style.display = '';
  resumeMedia(win); // 未読込(起動時の休止枠)なら読み込む。読込済みなら何もしない=再読み込みされない
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

    // サイトの色付きアイコン(T/Y/K/O)。どのサイトの枠か一目で分かるように。
    const site = siteOf(win.url);
    const siteIcon = document.createElement('span');
    siteIcon.className = 'mixer-row-site';
    siteIcon.textContent = site.letter;
    siteIcon.style.background = site.color;
    siteIcon.title = site.name;

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'mixer-row-label';
    // サイト部分は薄く、チャンネル名/動画IDを白太字で強調(どの配信か分かりやすく)。
    const parts = channelParts(win.url);
    const siteSpan = document.createElement('span');
    siteSpan.className = 'mx-site';
    siteSpan.textContent = (win.light ? '⚡ ' : '') + parts.site;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'mx-name';
    nameSpan.textContent = parts.name || parts.site;
    label.append(siteSpan, nameSpan);
    label.title = winLabel(win) + ' — クリックで最前面+その枠を光らせる';
    label.addEventListener('click', () => {
      if (win.hidden) {
        showWindow(win);
      } else {
        focusWindow(win);
        if (stackMode) win.el.scrollIntoView({ block: 'nearest' }); // タイルの位置まで送る
      }
      pulseWindow(win); // どの枠かパルスで知らせる
    });

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'mixer-row-eye';
    eye.textContent = win.hidden ? '🙈' : '👁';
    eye.title = win.hidden ? '表示する' : '表示を消す(音・再生は続いたまま。位置・サイズは保持)';
    eye.addEventListener('click', () => toggleHidden(win));
    top.append(siteIcon, label, eye);

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
const MIXER_HEIGHT_KEY = 'mvMixerHeight'; // 枠一覧パネルの高さ(縦リサイズ結果)を保存して次回復元する
function setupMixer() {
  const panel = document.getElementById('mixer-panel');
  makePanelDraggable(panel, panel.querySelector('.mixer-head'));
  wirePanelRaise(panel); // 掴む/フォーカスで最前面へ
  // 下端ハンドルで縦リサイズ(枠が増えて一覧が伸びる時用)。高さは保存し、次回も復元する。
  const resize = document.createElement('div');
  resize.className = 'mixer-resize';
  resize.title = '下端をドラッグして高さを変える';
  panel.appendChild(resize);
  makeMixerResizable(panel, resize);
  // 読込前にユーザーが高さを変えていたら、その操作を保存値で巻き戻さない。
  try {
    MV.storage.local.get(MIXER_HEIGHT_KEY, (r) => {
      const h = r && r[MIXER_HEIGHT_KEY];
      if (h && !panel.dataset.userResized) panel.style.height = h + 'px';
    });
  } catch (e) { /* noop */ }
  document.getElementById('mixer-close').addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('mixer-btn').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { raisePanel(panel); centerPanel(panel); syncMasterUI(); renderMixer(); } // 開いたら最前面+中央
  });
  const mm = document.getElementById('mixer-master');
  mm.addEventListener('input', () => { setMasterVolume(Number(mm.value) / 100); syncMasterUI(); });
  mm.addEventListener('change', () => saveLineup());
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
    onPointerDrag(handle, e, (ev) => {
      // 枠と同じく EDGE_KEEP px を画面内に残してはみ出しを許容する。
      // 上はドラッグハンドル(ヘッダ)がパネル先頭にあるので 0 で止める(出すと掴めなくなる)。
      const minL = EDGE_KEEP - el.offsetWidth;
      const maxL = stage.clientWidth - EDGE_KEEP;
      const maxT = Math.max(0, stage.clientHeight - EDGE_KEEP);
      el.style.left = Math.max(minL, Math.min(maxL, sl + ev.clientX - sx)) + 'px';
      el.style.top = Math.max(0, Math.min(maxT, st + ev.clientY - sy)) + 'px';
    }, () => document.body.classList.remove('panel-dragging'));
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
  const addPanel = addDialog.querySelector('.pos-dialog');
  const closeAdd = () => addDialog.classList.remove('open');
  // 開くたび中央へ置き直し、最前面にしてから表示(ドラッグで動かしても、開き直せば中央から始まる)。
  // 表示中にもう一度押したら閉じる(≡メニューの項目どうしで挙動を揃える)。
  const openAdd = (e) => {
    if (e) e.stopPropagation();
    if (addDialog.classList.contains('open')) { closeAdd(); return; }
    centerPanel(addPanel); raisePanel(addDialog); addDialog.classList.add('open');
  };
  document.getElementById('add-open-btn').addEventListener('click', openAdd);
  document.getElementById('empty-add-btn').addEventListener('click', openAdd); // 空ステージの大ボタンからも開ける
  document.getElementById('add-dialog-close').addEventListener('click', closeAdd);
  // 閉じるのは ✕ のみ(枠一覧/パフォーマンスと同じフロート挙動)。枠外クリックでは閉じず、背景も覆わないので
  // 出しっぱなしで連続追加でき、下のステージ操作もできる(オーバーレイは CSS で pointer-events:none)。
  // ヘッダ帯を掴んでドラッグ移動(配置ダイアログ/枠一覧と同じ仕組み)。掴む/フォーカスで最前面へ。
  if (addPanel) {
    makePanelDraggable(addPanel, addPanel.querySelector('.pos-dialog-head'));
    wirePanelRaise(addPanel, addDialog); // z は overlay(#add-dialog)側で上げる
  }

  const addUrl = document.getElementById('add-url');
  const addNote = document.getElementById('add-note');
  const note = (msg) => {
    if (!addNote) return;
    addNote.textContent = msg || '';
    addNote.hidden = !msg;
  };
  const doAdd = () => {
    const raw = addUrl.value.trim();
    if (!raw || wins.length >= MAX_WINDOWS) return;
    // スキームが無ければ https を補う(「twitch.tv/xxx」の貼り付けを許す)。
    const u = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;
    let parsed;
    try {
      parsed = new URL(u);
    } catch (e) {
      note('URL として読めません。配信ページのアドレスを貼り付けてください。');
      return;
    }
    // http(s) 以外は開かない(javascript: 等をこのページの文脈で実行させないため)。
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      note('http / https の URL だけを追加できます。');
      return;
    }
    // 対応サイト以外は、サイト側の X-Frame-Options により枠内が「接続拒否」になる。
    // 埋め込みを通すにはそのヘッダを剥がす必要があるが、対象を広げると無関係なサイトの
    // 埋め込み防御まで外すことになるため、ここで断る(rules.json の対象と一致させること)。
    if (!isEmbeddableHost(parsed.hostname)) {
      note(parsed.hostname + ' は枠に表示できません。埋め込みを許可しているのは Twitch / YouTube / mellow-fan / Kick だけです。');
      return;
    }
    note('');
    createWindow(u);
    addUrl.value = ''; // URL欄だけクリア。ダイアログは開いたまま=続けて貼り付けて追加できる。
  };
  addUrl.addEventListener('input', () => note('')); // 打ち直したら注意書きを消す
  document.getElementById('add-btn').addEventListener('click', doAdd);
  addUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

  setupLayoutDialog(); // 配置ダイアログ(📐): 整列・整形・保存・呼び出しの配線

  // ダイアログ内: 主要サイトのワンクリック追加(閉じないので、続けて何枠でも追加できる)。
  document.querySelectorAll('.site-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      // data-note 付き(Kick)はトップページから開けないサイト。理由を出すだけで枠は作らない。
      // disabled 属性にすると click が飛ばず理由を出せないので、見た目だけ非活性にしてある。
      if (btn.dataset.note) { note(btn.dataset.note); document.getElementById('add-url').focus(); return; }
      note('');
      const site = SITES[btn.dataset.site];
      if (site && wins.length < MAX_WINDOWS) createWindow(site.url);
    });
  });

  // メニュー位置: ダイアログ配線 + 保存値の復元(初回はアニメさせないため tb-ready を遅延付与)。
  setupPosDialog();
  setupPerfPanel();
  setupMixer();
  setupDanmakuPanel();
  setupCookieDialog();
  MV.storage.local.get(TOOLBAR_POS_KEY, (d) => {
    // 読込前にユーザーが位置を選んでいたら、その操作を保存値で巻き戻さない。
    if (!toolbarPosTouched) applyToolbarPos((d && d[TOOLBAR_POS_KEY]) || 'bottom', false);
    requestAnimationFrame(() => document.body.classList.add('tb-ready'));
  });
}

// ====== スマホ用メインメニュー(縦リスト) ======
// スマホ(縦積み)ではツールバーのバー表示をやめ、≡ から右クリックメニュー風の縦リストを出す。
// 項目: 追加・配置・一覧・パフォーマンス・弾幕設定(音量/並びはミキサー、軽量は各枠のバッジ)。
// 機能は既存ツールバーボタンを programmatic click して呼ぶ(状態・ロジックの二重化を避ける)。

function toggleMainMenu(force) {
  const menu = document.getElementById('main-menu');
  const backdrop = document.getElementById('main-menu-backdrop');
  const show = force != null ? force : menu.hidden;
  menu.hidden = !show;
  if (backdrop) backdrop.hidden = !show;
}

function setupMainMenu() {
  // 項目は pointerdown 時点で確定する。click 待ちだと、処理中にメニューが消えた場合に
  // ブラウザが click を「いま指の下の要素=下のタイルの iframe」へ振り直してしまうため
  // (preventDefault で後続の click 合成自体も止める)。
  const mkAct = (id, fn) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  };
  // 項目をクリックしてもメニューは閉じず出しっぱなしにする(連続で複数のパネルを開ける)。
  // 閉じるのは「メニュー外(backdrop)のクリック」だけ(下の main-menu-backdrop 配線)。
  const act = (id, fn) => mkAct(id, fn);
  act('mm-add', () => document.getElementById('add-open-btn').click());
  act('mm-layout', openLayoutDialog);
  act('mm-mixer', () => document.getElementById('mixer-btn').click());
  act('mm-perf', () => document.getElementById('perf-btn').click());
  act('mm-danmaku', () => openDanmakuPanel(null)); // 全体対象で弾幕設定パネルを開く
  act('mm-cookie', openCookieDialog);
  // 透明バックドロップ: メニュー外のタップは「閉じる」だけで、下のタイルへは絶対に流さない。
  document.getElementById('main-menu-backdrop').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMainMenu(false);
  });
}

// 配置ダイアログ(📐 配置)の配線。整列・整形は即実行して閉じ、保存は一覧へ反映する。
function setupLayoutDialog() {
  const dlg = document.getElementById('layout-dialog');
  if (!dlg) return;
  // 整列/整形を実行してもダイアログは閉じない(× だけで閉じる)。実行後すぐ別の操作・微調整ができる。
  const tile = document.getElementById('layout-tile');
  if (tile) tile.addEventListener('click', () => tileAll());
  const snap = document.getElementById('layout-snap');
  if (snap) snap.addEventListener('click', () => snapLayout());
  const nameInput = document.getElementById('layout-name');
  const save = document.getElementById('layout-save');
  const doSave = async () => {
    await saveLayout(nameInput ? nameInput.value : '');
    if (nameInput) nameInput.value = '';
    renderLayoutList();
  };
  if (save) save.addEventListener('click', doSave);
  if (nameInput) nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  const close = document.getElementById('layout-dialog-close');
  if (close) close.addEventListener('click', closeLayoutDialog);
  // 閉じるのは ✕ のみ(枠一覧/パフォーマンスと同じフロート挙動。枠外クリックでは閉じない)。
  // ヘッダ帯を掴んでドラッグ移動(枠一覧/パフォーマンスと同じ makePanelDraggable)。掴む/フォーカスで最前面へ。
  const panel = dlg.querySelector('.pos-dialog');
  if (panel) {
    makePanelDraggable(panel, panel.querySelector('.pos-dialog-head'));
    wirePanelRaise(panel, dlg); // z は overlay(#layout-dialog)側で上げる
  }
}

// ポインタが一定時間動かなかったら、まずカーソル+常駐UI(≡メニュー/⛶全画面を終了)を消し(IDLE_CURSOR_MS)、
// さらに操作が無ければツールバー本体も畳む(TOOLBAR_HIDE_MS。すぐ消えると使いづらいので長めに残す)。
// 「カーソルと一緒に ≡ も消す」は body.idle に相乗りした CSS が担当(multiview.css の body.idle ルール)。
// マウス/指を動かすと arm() が即 body.idle を外し、カーソルと ≡/全画面終了ボタンが戻る(= 動かしている間は表示)。
// 一方ツールバー本体(toolbar-hidden)は時間で畳んだら、戻すのは ≡ を押した時だけ(勝手に出さない)。
function setupIdleHide() {
  const toolbar = document.getElementById('toolbar');
  let cursorTimer = null;
  let toolbarTimer = null;
  let idle = false;
  // body.idle(カーソル+常駐UIを消す)はトップ文書にしか効かない。枠(iframe)の上のカーソルは iframe 側の
  // 文書が管理するので、idle の変化を各 frame へ通知して中のカーソルも消す/戻す(stream-control が set-idle を処理)。
  const broadcastIdle = (on) => {
    wins.forEach((w) => {
      try { if (w.frame) w.frame.contentWindow.postMessage({ [MAGIC]: true, type: 'set-idle', value: on }, '*'); } catch (e) { /* noop */ }
      try { if (w.chatFrame) w.chatFrame.contentWindow.postMessage({ [MAGIC]: true, type: 'set-idle', value: on }, '*'); } catch (e) { /* noop */ }
    });
  };
  const setIdle = (on) => {
    if (on === idle) return; // 変化時のみ(postMessage 連発を防ぐ)
    idle = on;
    document.body.classList.toggle('idle', on);
    broadcastIdle(on);
  };
  // ツールバー上にポインタがある(操作中)なら消さない/隠さない。離れて静止すれば次の動きで再武装される。
  const hideCursor = () => {
    if (toolbar.matches(':hover')) return;
    setIdle(true);
  };
  const hideToolbar = () => {
    if (toolbar.matches(':hover')) return;
    document.body.classList.add('toolbar-hidden');
  };
  let lastArm = 0;
  const arm = () => {
    setIdle(false); // カーソル+常駐UIを戻す(枠内へも通知)。toolbar-hidden は触らない
    const now = Date.now();
    if (now - lastArm < 250) return; // pointermove 連発でのタイマ再生成を間引く(精度より省電力)
    lastArm = now;
    clearTimeout(cursorTimer);
    clearTimeout(toolbarTimer);
    cursorTimer = setTimeout(hideCursor, IDLE_CURSOR_MS);
    toolbarTimer = setTimeout(hideToolbar, TOOLBAR_HIDE_MS);
  };
  ['pointermove', 'pointerdown'].forEach((ev) => document.addEventListener(ev, arm, { passive: true }));
  // 枠(iframe)内の操作は親の pointermove に乗らない。content script が tile-activity を中継してくるので
  // それで arm() する。これで枠の上で動かしている間もトップを「活動中」に保てる(カーソル/≡ が消えない)。
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d[MAGIC] !== true || d.type !== 'tile-activity') return;
    if (wins.some((w) => (w.frame && w.frame.contentWindow === e.source) || (w.chatFrame && w.chatFrame.contentWindow === e.source))) arm();
  });
  arm();
}

// ツールバーの配置(上/下/左/右)を適用。body のクラスで CSS が位置とレイアウト(横/縦バー)を切替える。
// save=false は起動時の復元用(storage へ書き戻さない)。
// save=true はユーザー操作由来。起動時の復元(save=false)が後から来ても巻き戻さないよう印を付ける。
let toolbarPosTouched = false;
function applyToolbarPos(pos, save = true) {
  if (save) toolbarPosTouched = true;
  if (!TOOLBAR_POSITIONS.includes(pos)) pos = 'top';
  const vertical = pos === 'left' || pos === 'right';
  TOOLBAR_POSITIONS.forEach((p) => document.body.classList.toggle('tb-pos-' + p, p === pos));
  document.body.classList.toggle('tb-vertical', vertical);
  document.querySelectorAll('.pos-pick').forEach((b) => b.classList.toggle('active', b.dataset.pos === pos));
  relayoutStack(); // 縦積み中はツールバーの避け方が変わるので積み直す(自由配置では何もしない)
  if (save) {
    try { MV.storage.local.set({ [TOOLBAR_POS_KEY]: pos }); } catch (e) { /* noop */ }
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
  wirePanelRaise(panel); // 掴む/フォーカスで最前面へ

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
      const info = await MV.system.cpu.getInfo();
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
      const m = await MV.system.memory.getInfo();
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
      panel.removeAttribute('hidden'); btn.classList.add('on-blue'); raisePanel(panel); centerPanel(panel); start(); // 開いたら最前面+中央
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

  // mellow-fan(旧 OPENREC)。URL 形式は改名後も /live/<id> ・ /movie/<id> のまま。
  if (host.includes('mellow-fan.com') || host.includes('openrec.tv')) {
    if ((segs[0] === 'live' || segs[0] === 'movie') && segs[1]) {
      return 'https://www.mellow-fan.com/embed/' + encodeURIComponent(segs[1]);
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

// URL を「サイト部分」と「チャンネル名/識別子」に分ける。一覧でその部分を強調するため。
//  例: twitch.tv/jun_channel → { site:'twitch.tv/', name:'jun_channel' }
//      youtube.com/watch?v=ABcd → { site:'youtube.com/', name:'ABcd' }(watch だけにせず動画IDを出す)
function channelParts(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const segs = u.pathname.split('/').filter(Boolean);
    let name = '';
    if (host.includes('youtube') || host === 'youtu.be') {
      if (host === 'youtu.be') name = segs[0] || '';
      else if (segs[0] === 'watch') name = u.searchParams.get('v') || 'watch';
      else if (['live', 'shorts', 'embed'].includes(segs[0])) name = segs[1] || segs[0];
      else name = segs[0] || '';
    } else if (host.includes('openrec') || host.includes('mellow-fan')) {
      name = segs[segs.length - 1] || '';
    } else if (host.startsWith('player.twitch')) {
      name = u.searchParams.get('channel') || u.searchParams.get('video') || '';
    } else {
      name = segs[0] || ''; // twitch / kick: 最初のセグメント = チャンネル名
    }
    return { site: host + (name ? '/' : ''), name };
  } catch (e) {
    return { site: '', name: url };
  }
}

// URL からサイトを判定し、一覧用の色・頭文字・名前を返す。
function siteOf(url) {
  const h = hostOf(url);
  if (h.includes('twitch')) return { letter: 'T', color: '#9147ff', name: 'Twitch' };
  if (h.includes('youtube') || h === 'youtu.be') return { letter: 'Y', color: '#ff0033', name: 'YouTube' };
  if (h.includes('kick')) return { letter: 'K', color: '#53fc18', name: 'Kick' };
  if (h.includes('mellow-fan') || h.includes('openrec')) return { letter: 'M', color: '#ffd200', name: 'mellow-fan' };
  return { letter: '•', color: '#6e7681', name: h || 'その他' };
}

// 枠を一時的にパルス(光る枠)で強調する。ミキサーで項目をクリックした時に「これがその枠」を示す。
function pulseWindow(win) {
  win.el.classList.remove('pulse');
  void win.el.offsetWidth; // 連続クリックでアニメを頭から再生させるため reflow
  win.el.classList.add('pulse');
  clearTimeout(win.pulseTimer);
  win.pulseTimer = setTimeout(() => win.el.classList.remove('pulse'), 1300);
}

function updateWinTitle(win) {
  if (win.titleEl) win.titleEl.textContent = winLabel(win);
  // 左上バッジを更新(どのモードかひと目でわかるように。Kick は常時 HLS 直再生=軽量)。
  if (win.badgeEl) {
    const light = !!win.light || !!win.video;
    // 🎭=シアター動作中 / 🔎=有効だが主映像を探索中(診断用。frame 内 stream-control からの通知)。
    const mark = win.theaterState === 'on' ? ' 🎭' : win.theaterState === 'searching' ? ' 🔎' : '';
    // 🛡=この枠に広告ブロック(別拡張の vaft)が効いている / 🚫=Twitch枠なのに効いていない。
    // 未報告(undefined)のうちは何も出さない。Twitch 以外の枠では報告自体が来ない。
    const shield = win.vaft === undefined ? '' : win.vaft === null ? ' 🚫' : ' 🛡';
    // 💬=弾幕がチャット欄を監視中 / 💬⚠=ONなのに見つからない(サイトのDOM変更の疑い)。
    const dmk = win.danmakuState === 'on' ? ' 💬' : win.danmakuState === 'missing' ? ' 💬⚠' : '';
    const status = mark + shield + dmk;
    win.badgeEl.textContent = (light ? '⚡ 軽量' : '通常') + status;
    win.badgeEl.classList.toggle('light', light);
    // 通常モードのバッジは CSS で display:none にされているため、状態表示が乗るときだけ戻す。
    win.badgeEl.classList.toggle('diag', status !== '');
    // 異常(広告ブロック未注入 / 弾幕のチャット欄が見つからない)はホバー待ちにせず常時見せる。
    win.badgeEl.classList.toggle('diag-warn', win.vaft === null || win.danmakuState === 'missing');
    // Kick は切替不可。通常⇄軽量できる枠だけタップのヒントを出す。
    const canToggle = !win.video && (win.light || !!toLightUrl(win.url));
    win.badgeEl.disabled = !canToggle;
    win.badgeEl.title = canToggle
      ? (win.light ? 'タップで通常表示に戻す' : 'タップで軽量プレイヤーに切替')
      : '';
  }
}
