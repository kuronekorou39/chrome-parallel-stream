// 枠の生成・位置・表示/非表示・削除。

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
  setVolIcon(volIcon, WIN_VOLUME_DEFAULT);
  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = '100';
  volSlider.title = 'この枠の音量';
  volWrap.append(volIcon, volSlider);

  // Kick の配信ページは、公式プレイヤー(player.kick.com)+ popout チャットの2枚組にする。
  // 再生リストの CORS は Kick の許可オリジンにしか開いておらず、このページから hls.js では読めない。
  // トップや一覧はサイト全体を開き、枠の中で配信を選んだら onFrameUrl が2枚組へ切り替える。
  const isKick = !!kickWatchChannel(url);
  // YouTube は視聴ページを枠に入れると Chromium が落ちるため、埋め込みプレイヤーで映像を出し、
  // チャットは公式の live_chat 枠を横に並べる(Kick と同じ2分割)。
  // 2分割の器は枠の生成時にしか作れないので、トップページ等でも YouTube なら先に用意しておく
  // (枠の中で動画を選んだ時点で埋め込みへ切り替わり、そのままチャットも出せるように)。
  const siteHost = hostOf(url);
  const siteKey = siteKeyOf(siteHost);
  const isYouTube = isYouTubeWatchHost(siteHost);
  // Twitch も軽量表示では「プレイヤー + 埋め込みチャット」の2枚組にする。サイト全体を出すと
  // レイアウトも書き込みもサイト側の都合に左右され、縦長のときに使い物にならないため。
  const isTwitch = siteKey === 'twitch' && !siteHost.startsWith('player.');
  const hasChatPane = isYouTube || isTwitch || siteKey === 'kick';

  const controls = document.createElement('div');
  controls.className = 'win-controls';
  // 音声は各プレイヤー自前のミュート/音量で操作する方針(起動時のみ全ミュート)。
  // よって枠ヘッダにミュート/ソロボタンは置かない。
  const openBtn = mkBtn(':external:', '', '元サイトを新しいタブで開く(ログイン/操作用)');
  const reloadBtn = mkBtn(':reload:', '', 'この枠を再読込');
  const chatBtn = hasChatPane ? mkBtn(':chat:', 'active', 'チャットの表示/非表示') : null;
  const adjustBtn = mkBtn(':adjust:', '', 'この枠の透明度・画質を調整');
  const maxBtn = mkBtn(':fullscreen:', 'max', '最大化/復元'); // 縦積みモードでは CSS で隠す
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
  let chatFrame = null;
  let mediaEl = null; // チャットと2分割するとき、映像側を入れる箱(無ければ body 直下)
  if (hasChatPane) {
    // 映像(埋め込みプレイヤー)は mountSiteFrame() が .win-media の中へ作る。
    // チャットはここで枠だけ用意し、読み込みは mountChatFrame() に任せる(URL 変更・再読込と共用)。
    // chat-on は付けない。チャットがあると分かってから出す(先に出して畳むと画面がガタつく)。
    body.classList.add('split-chat');
    const media = document.createElement('div');
    media.className = 'win-media';
    body.appendChild(media);
    mediaEl = media;
    // チャットは入れ物(.win-chat-wrap)に入れる。縦積みでは入れ物を入力欄の高さまで縮め、
    // 中の iframe は下端を合わせたまま高いままにして、入力欄だけが見えるようにする
    // (別オリジンなので中の要素を取り出せない。切り出しでしか実現できない)。
    const wrap = document.createElement('div');
    wrap.className = 'win-chat-slot win-chat-wrap';
    const chat = document.createElement('iframe');
    chat.className = 'win-chat';
    chat.allow = IFRAME_ALLOW; // 映像側と同じ許可。無いとスマホでセンサーが弾かれて記録が残る
    wrap.appendChild(chat);
    body.appendChild(wrap);
    chatFrame = chat;
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
    id, url, el, body, frame, chatFrame, mediaEl, chatBtn, bar, barX: 0, titleEl: title, volSlider, volIcon,
    maximized: false, hidden: false, light: false, tall: null, span: 'full', zoom: null,
    // YouTube の通常表示は Chromium が落ちるので、この枠には切替先を出さない。
    // ⋮メニューの生成(buildQuickControls)より前に決まっている必要がある。
    noNormalMode: isYouTube,
    history: [],
    prevRect: null, freeRect: null,
    // 枠ごとの音量の既定。実音量 = これ × マスタ。最初から大きいと事故になるので半分から。
    opacity: 100, vol: WIN_VOLUME_DEFAULT,
    // 映像と音を遅らせる秒数(Twitch のライブのみ)。その場の音合わせ用なので保存しない。
    delay: 0, delayState: null,
    // 遅延 0 でも再生位置を固定するか(音で合わせた枠。理由は twitch-keepalive.js の delayHold)。
    delayHold: false,
    filter: { bright: 100, contrast: 100, sat: 100 },
    // 弾幕とチャットは全体の既定から始める(復元時は restoreLineup が保存値で上書きする)。
    chatOn: chatDefaultOn,
    danmaku: { on: danmakuDefaultOn, layer: null, lanes: [], overrides: {} } // コメント弾幕(層/レーンは非保存。overrides=この枠だけの上書き)
  };
  wins.push(win);

  // 縦積みモード用の簡易UI([⋮][✕]+メニュー。通常モードでは CSS で非表示)。
  el.appendChild(buildQuickControls(win));
  // 軽量モードの復元(保存後に URL が変換できない形へ変わっていたら通常表示に落とす)。
  // YouTube は通常表示だとレンダラが落ちるので、保存内容にかかわらず埋め込みで開く。
  // Twitch は新規の枠だけ既定を2枚組(プレイヤー+チャット)にする。サイト全体だとチャット列が
  // 出ず、縦長でコメントも入力欄も使えないため。復元時は保存された選択(opts.light)を尊重する。
  const defaultLight = isYouTube || isKick || (isTwitch && opts.light === undefined);
  win.light = (defaultLight || !!opts.light) && !!toLightUrl(url);
  pushWinHistory(win, url); // ⋮メニューの「戻る」用。最初のページを起点にする
  updateWinTitle(win);

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
  // 右クリックの抑止はページ全体で行う(下の suppressContextMenu)。枠の上だけでは、
  // 枠の外や余白で出てしまう。
  makeBarHandle(win, bar);
  resizeGrip.addEventListener('pointerdown', (e) => beginResize(win, resizeGrip.dataset.dir, e));
  // 台形内の音量バー: 操作しても枠は動かさない(makeBarHandle が .win-vol を除外)。即反映+離したら保存。
  volSlider.value = String(Math.round((win.vol != null ? win.vol : WIN_VOLUME_DEFAULT) * 100));
  volSlider.addEventListener('input', () => {
    setWinVol(win, Number(volSlider.value) / 100); // 台形/ミキサー両方のスライダーを同期
    revealHeader(win); // 操作中はヘッダを消さない(特にタッチ)
  });
  volSlider.addEventListener('change', onWinVolCommitted);
  wireVolIcon(volIcon, () => { toggleWinMute(win); revealHeader(win); });
  openBtn.addEventListener('click', (e) => { e.stopPropagation(); openOriginal(win); });
  reloadBtn.addEventListener('click', (e) => { e.stopPropagation(); reloadWindow(win); });
  if (chatBtn) chatBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleChat(win); });
  adjustBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleAdjust(win); });
  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(win); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(win); });
  bar.addEventListener('dblclick', () => toggleMax(win));
  if (!opts.startHidden && !opts.deferLoad) mountSiteFrame(win);
  applyVolume(win, masterVolume);
  syncChatVisibility(win); // 全体の既定(chatDefaultOn)を反映。Kick はこの時点で確定する

  // 枠一覧は「最初の枠ができた時」に開く。まだ何も無い画面に出しても操作する対象が無く、
  // 邪魔なだけなので出さない。以後は自動で出し直さない(閉じたら閉じたまま)。
  if (!stackMode && !mixerAutoShown && wins.length === 1) {
    mixerAutoShown = true;
    openMixer();
  }

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
    scheduleAutoLayout();
    updateCount();
    saveLineup();
    renderMixer();
  }
  return win;
}

function mkBtn(label, cls, title) {
  const b = document.createElement('button');
  b.type = 'button';
  putLabel(b, label);
  if (cls) b.className = cls;
  if (title) b.title = title;
  return b;
}

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
  updateWinShapeClass(win, w, h);
  clampBarX(win);
}

// チャットを横に並べるか下に置くかを決める。横に並べるとチャット列が固定幅(300px)を取るので、
// 枠が狭いと映像がその残りまで潰れる(幅 560px で映像 258px まで痩せていた)。
// 映像に十分な幅が残らないなら下に回す。縦長の枠も同様。
// w/h を直接見るのでレイアウト読み取り(reflow)は起こさない。
const CHAT_SIDE_MIN_W = 680; // これ未満の幅ではチャットを下に置く(チャット300 + 映像360 相当)
// 下に置いたチャットが取る高さ(CSS の max(340px, 42%) と一致させること)。
const CHAT_BELOW_MIN_H = 340;
const CHAT_BELOW_RATIO = 0.42;
// 映像に残す最低の高さ。チャットを下に置くと固定で 340px 取られるため、背の低い枠では
// 映像が潰れて「コメント欄だけの枠」になる。これを割り込むならチャットの方を畳む
// (💬 の ON/OFF 自体は触らないので、枠を広げれば黙って戻る)。畳み始める枠の高さは
// この値 + 340px(= 540px)。早すぎ/遅すぎるならここを動かす。
const CHAT_MEDIA_MIN_H = 200;
function updateWinShapeClass(win, w, h) {
  const below = h > w || w < CHAT_SIDE_MIN_W;
  win.el.classList.toggle('chat-below', below);
  win.el.classList.toggle('span-half', win.span === 'half'); // 半幅ではチャットを出さない(CSS 側)
  win.el.classList.toggle('is-tall', isTall(win)); // 縦長ならチャットを一覧ごと出す(CSS 側)
  // 自動で畳むのは自由配置(PC)で「下に置く」形のときだけ。横並びは幅 680px 以上でしか選ばれない
  // ので映像に 380px 以上残り、潰れない。縦積み(スマホ)はタイル高の決め方も、チャットに割く高さ
  // (STACK_CHAT_INPUT_H)も別なのでこの式が当てはまらない。しかも畳むとタイルが縮んでまた判定が
  // 変わる…と行ったり来たりするため、こちらでは判定しない。
  const cramped = !stackMode && below && h - Math.max(CHAT_BELOW_MIN_H, h * CHAT_BELOW_RATIO) < CHAT_MEDIA_MIN_H;
  if (win.el.classList.contains('cq-hide-chat') !== cramped) {
    win.el.classList.toggle('cq-hide-chat', cramped);
    syncChatVisibility(win); // 畳む/戻す(⋮の💬の説明もここで更新される)
  }
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
  scheduleAutoLayout();
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

// 枠の主メディア(iframe)。色調整はここに CSS filter を当てる。
function mediaEl(win) {
  return win.frame || null;
}

// 明るさ/コントラスト/彩度を CSS filter で適用。cross-origin iframe にも描画結果として効く。
function applyFilter(win) {
  const m = mediaEl(win);
  if (!m) return;
  const f = win.filter || { bright: 100, contrast: 100, sat: 100 };
  m.style.filter =
    'brightness(' + f.bright + '%) contrast(' + f.contrast + '%) saturate(' + f.sat + '%)';
}

function closeWindow(win) {
  // 遅延読み込み待ちのまま閉じられた枠を、あとから loadWindowMedia が読み込んでしまうのを防ぐ。
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
  scheduleAutoLayout();
  if (wasSinkOwner) {
    // 共有シンクのオーナー枠を閉じた → 残りの同サイト枠を作り直して音声を復帰(=手動リロードの自動化)。
    setTimeout(() => { sameSiteSurvivors.forEach((w) => { if (wins.indexOf(w) >= 0) remountFrame(w); }); }, 150);
  }
}

function updateCount() {
  countEl.textContent = wins.length;
  document.getElementById('count-max').textContent = MAX_WINDOWS;
  stageEmpty.style.display = wins.length ? 'none' : 'flex';
  document.getElementById('add-btn').disabled = wins.length >= MAX_WINDOWS;
}

// 枠を「隠す/表示する」。見た目を消すだけで、再生も音も止めない(再マウントもしない)。
// 位置・サイズ・URLは保持。起動時に未読込で復元された枠だけ、初回表示時に resumeMedia で読み込む。
function hideWindow(win) {
  clearStackMax(win);
  win.hidden = true;
  win.el.style.display = 'none'; // メディアはそのまま(再生・音・通信を継続)
  if (stackMode) relayoutStack(); // 空いた分を詰める
  scheduleAutoLayout();
  renderMixer();
  saveLineup();
}
function showWindow(win) {
  win.hidden = false;
  win.el.style.display = '';
  resumeMedia(win); // 未読込(起動時の休止枠)なら読み込む。読込済みなら何もしない=再読み込みされない
  applyVolume(win, masterVolume);
  focusWindow(win); // 出したら最前面へ
  scheduleAutoLayout();
  if (stackMode) {
    relayoutStack();
    win.el.scrollIntoView({ block: 'nearest' });
  }
  renderMixer();
  saveLineup();
}
function toggleHidden(win) { win.hidden ? showWindow(win) : hideWindow(win); }

// 枠の表示名(軽量プレイヤー中は ⚡ を付けて区別)。台形ヘッダとミキサーの両方で使う。
function winLabel(win) {
  return (win.light ? LIGHT_MARK : '') + labelFor(win.url);
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
  // 左上バッジは廃止。軽量/通常・シアター・広告ブロック・弾幕の状態を出していたが、
  // どれも作っている最中の確認用で、使う側には意味が無い(モードは自動で決まるようになり、
  // 残りは動いているかどうかの内部状態)。映像の上に文字が乗るぶん邪魔でもあった。
}
