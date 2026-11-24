// 起動処理。他のファイルをすべて読んだ後に動かすため、必ず最後に読み込む。

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
  const autoData = await MV.storage.local.get(AUTO_LAYOUT_KEY);
  autoLayout = initialAutoLayout(autoData[AUTO_LAYOUT_KEY], (saved.wins || saved.urls || []).length > 0);
  if (autoData[AUTO_LAYOUT_KEY] === undefined) MV.storage.local.set({ [AUTO_LAYOUT_KEY]: autoLayout }); // 判定を次回へ持ち越さない
  syncAutoLayoutUI();
  const layoutOpts = await MV.storage.local.get([VOLUME_OVERLAP_KEY, AUTO_HIDE_ENDED_KEY]);
  volumeOverlap = layoutOpts[VOLUME_OVERLAP_KEY] !== false; // 既定はオン
  autoHideEnded = layoutOpts[AUTO_HIDE_ENDED_KEY] !== false; // 既定はオン
  syncLayoutOptionsUI();

  // 弾幕の共通(既定)設定を復元(壊れた値は dmkSanitize で弾く)。枠ごとの上書きは restoreLineup で。
  if (saved.danmakuGlobal) dmkGlobal = Object.assign({}, DMK_DEFAULTS, dmkSanitize(saved.danmakuGlobal));
  // 弾幕/チャットの全体既定。枠を作る前に読むこと(createWindow がこの値で初期化するため)。
  if (saved.defaults) {
    danmakuDefaultOn = saved.defaults.danmaku === true;
    chatDefaultOn = saved.defaults.chat === true;
  }
  syncMainMenuToggles();

  // マスタ音量を復元(無ければ 0)。窓を作る前に入れておき、各枠が最初からこの音量で開くように。
  masterVolume = clampVol(saved.masterVolume);
  syncMasterUI();

  // 新フォーマット(wins: 位置・サイズ付き)を優先して位置ごと復元。旧フォーマット(urls のみ)は
  // 初回だけ整列にフォールバック。以後は移動・リサイズのたびに保存されるので勝手に整列し直さない。
  let deferred = []; // 表示するが中身は順次読み込む枠(更新時の同時読込を避ける)
  // 別サイトのリンク(?add=)から開かれたときは、前回の並びを復元せず、渡された配信に置き換える。
  // 音量や弾幕などの全体の設定は、上で読んだ前回のものをそのまま使う。
  const added = addedUrlsFrom(location.search);
  dropAddedUrls();
  if (added.length) {
    deferred = added.map((u) => createWindow(u, { silent: true, deferLoad: true })).filter(Boolean);
    tileAll();
  } else if (Array.isArray(saved.wins) && saved.wins.length) {
    deferred = restoreLineup(saved); // マスタ音量・各枠を復元し、表示すべき枠の配列を受け取る
  } else {
    const urls = (saved.urls || []).map((u) => (u || '').trim()).filter((u) => u.length > 0).slice(0, MAX_WINDOWS);
    urls.forEach((u) => createWindow(u, { silent: true }));
    if (urls.length) tileAll(); // 旧データの初回だけ整列(以後は位置を保存・復元)
  }
  // 復元では最後に作った枠が選択されたままになる。選択中の枠は整列でも手前に残すので、
  // 開いた直後に音量の小さい枠が手前へ来ないよう、ここで選択を外しておく。
  clearSelection();
  restoring = false; // 以後の移動/リサイズ/追加/削除は保存する
  if (added.length) saveLineup(); // 置き換えた並びを、次に開いたときの「前回の状態」にする
  updateCount();
  // 復元した枠は silent で作る(= 1枠ごとには一覧を描き直さない)ので、ここで一度だけ作り直す。
  // これが無いと、1枠目が出来た時点で自動表示した枠一覧が「1件」のまま止まる。
  renderMixer();

  scheduleAutoLayout(); // 前回と画面サイズが違っていても、開いた時点で合わせる

  // 表示枠を 1 枠ずつ間隔をあけて読み込む(同時読込の 429/初期化ピーク回避)。各枠はスピナーを出して待つ。
  await loadDeferred(deferred);
})();
window.addEventListener('message', onChatAvailability);
window.addEventListener('message', onPlayerInfo);
window.addEventListener('mv-ext-ready', checkExtVersion);
// 拡張機能の応答が、このファイルの読み込みより先に届くことがある(版が上がった直後は
// このファイルがキャッシュに無く、取得に時間がかかるため)。そのときは合図を取り逃しているので、
// ここで確かめる。版が上がった直後こそ案内が要る場面なので、逃すと誰にも出ない。
if (MV.extVersion) checkExtVersion();

// 右クリックは枠の移動に割り当てているので、このページではブラウザのメニューを出さない。
// 枠の上だけ抑止していたが、枠の外・余白・パネルの上では出てしまい、操作の途中で邪魔になっていた。
// 入力欄の上だけは残す(貼り付けメニューが使えなくなるため)。
// ※ 枠の中(iframe)は別オリジンなのでここでは届かない。あちらは stream-control.js が同じことをする。
function suppressContextMenu(e) {
  try {
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  } catch (err) { /* noop */ }
  e.preventDefault();
}
document.addEventListener('contextmenu', suppressContextMenu);
