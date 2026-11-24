// 設定値と、ファイルをまたいで共有する状態。

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
const TOOLBAR_HIDE_MS = 30000; // この時間操作が無いとツールバーを隠し、≡メニューと「追加」「配置」も閉じる
const IS_COARSE = window.matchMedia('(pointer: coarse)').matches; // 主ポインタが指(スマホ/タブレット)か
const ZOOM_DEFAULT_FULL = 75; // 枠内サイト縮小率(🔍)の既定(全幅タイル)。一覧しやすいよう少し縮める
const ZOOM_DEFAULT_HALF = 50; // 同(50%幅タイル)。横に2つ並ぶ小さい枠なのでより縮める
// 枠ヘッダ/ボタンの一時表示の自動消去。操作が無ければ完全に消す(映像に重ねない)。
// タッチはマウスと違って「離れる」動作が無いので長めに取っていたが、枠のどこをタップしても
// 出せるようになった(tile-tap)ので、出しっぱなしの方が邪魔になった。半分に縮める。
const BAR_HIDE_MS = IS_COARSE ? 6000 : 4000;
// 縦積みでチャットに足すタイル高(CSS の .win-chat-slot と一致させること)。
// Kick は一覧ごと出すので 340(280 では入力欄が枠外に出て書き込めなかった)。
// Twitch / YouTube は入力欄だけを残すので、その高さぶんで足りる。
const STACK_CHAT_H = 340;
const STACK_CHAT_INPUT_H = 132;
const RESTORE_STAGGER_MS = 1000; // 起動(更新)時、複数枠を一気に読まず順次読み込む間隔。同時読込による 429/初期化ピークを避ける
const LOAD_SPINNER_FALLBACK_MS = 8000; // 読み込みスピナーを必ず消す保険(load イベントが来ないサイト/エラー対策)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STACK_TALL_RATIO = 0.75; // 縦長タイルの高さ(ステージ高比)。⋮の「高さ切替」で縦長にした枠に使う
// 最後のタイルの下に足す空きの量(画面高に対する比)。下端は ≡ メニューが重なり、
// キーボードが出ると画面の下半分が埋まるので、最後の枠を上へ送れるだけの余地を残す。
const STACK_TAIL_RATIO = 0.5;
const TOOLBAR_POS_KEY = 'toolbarPos'; // ツールバーの配置(top/bottom/left/right)を保存する storage キー
const TOOLBAR_POSITIONS = ['top', 'bottom', 'left', 'right'];
const PERF_HISTORY = 60; // パフォーマンスパネルのスパークラインに保持するサンプル数(≒直近60秒)
const MAGIC = '__multiviewControl';
// accelerometer / gyroscope は YouTube の公式埋め込みコードが要求する。渡さないと、枠の中の
// プレイヤーがセンサーを使おうとして弾かれ、Permissions policy 違反として記録される
// (スマホで実際に発生。360度動画の傾き操作が効かないだけで再生自体には影響しないが、
//  拡張機能のエラー欄に残り続けるので許可する)。
// magnetometer は deviceorientation を使うために要る(accelerometer と gyroscope だけでは
// 「deviceorientation events are blocked」になる。スマホの実機で発生)。
// センサー系に * を付けるのは、枠の中でさらに入れ子になる別オリジンのフレームまで委譲するため。
// 既定('src' 相当)だと枠自身のオリジンにしか届かず、YouTube/Twitch が内部で読み込む
// フレームで違反が記録され続ける(枠の iframe に許可を付けても消えなかった。実機で確認)。
const IFRAME_ALLOW =
  'accelerometer *; gyroscope *; magnetometer *; autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';

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
// 全体音量(0〜1)。実音量 = 枠ごとの音量 × これ。
// 既定は 0(完全無音)にしていたが、音が出ないと壊れているように見える。かといって最初から
// 大きいほうが害が大きいので、聞こえるが驚かない程度から始める。
const MASTER_VOLUME_DEFAULT = 0.1;
const WIN_VOLUME_DEFAULT = 0.5; // 枠ごとの音量の既定
let masterVolume = MASTER_VOLUME_DEFAULT;
// 弾幕とチャットの「全体の既定」。次に追加される枠に適用し、≡メニューのトグルで全枠まとめて
// 切り替える(切り替えるとこの既定も更新される)。保存して次回以降も引き継ぐ。
// チャットの既定は「畳む」。コメントは弾幕で読めるうえ、列を出すと映像がその分狭くなるため
// (PC・スマホとも。出したい枠は ⋮ の 💬、全部出すなら ≡ の「チャット」で)。
let danmakuDefaultOn = false;
let chatDefaultOn = false;
let mixerAutoShown = false; // 枠一覧の自動表示は1回だけ(閉じたら勝手に出し直さない)
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

// 自動配置: 枠の増減や画面サイズの変更があったら、選んだ方式で並べ直す。定期実行はしない。
// 手で決めた大きさを勝手に戻さないよう、リサイズ・最大化・別の配置の実行でオフになる(移動だけなら続く)。
// init の同期部分から参照されうるので、ここ=init より前で初期化する。
const AUTO_LAYOUT_KEY = 'autoLayoutMode';
const AUTO_LAYOUT_MODES = ['off', 'tile', 'volume'];
const AUTO_LAYOUT_LABELS = { tile: '自動・整列', volume: '自動・音量順' };
const AUTO_LAYOUT_DEBOUNCE_MS = 150; // 連続した変化(複数枠の追加・窓のリサイズ)を 1 回にまとめる
let autoLayout = 'off';
let autoLayoutTimer = 0;
let panelsNeedAvoid = false; // 枠の並びが変わり、開いているポップアップが重なったかもしれない
const VOLUME_OVERLAP_KEY = 'volumeLayoutOverlap';
let volumeOverlap = true; // 音量順で、枠を重ねて隙間を埋める
const AUTO_HIDE_ENDED_KEY = 'autoHideEndedStreams';
const STREAM_END_HIDE_MS = 60000; // 一時的な切断では隠さないよう、終了の表示がこの間続いたら隠す
let autoHideEnded = true;
