// 枠一覧 / ミキサー。

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
    siteSpan.textContent = (win.light ? LIGHT_MARK : '') + parts.site;
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
    putLabel(eye, win.hidden ? ':eye-off:' : ':eye:');
    eye.title = win.hidden ? '表示する' : '表示を消す(音・再生は続いたまま。位置・サイズは保持)';
    eye.addEventListener('click', () => toggleHidden(win));
    top.append(siteIcon, label, eye);

    const bot = document.createElement('div');
    bot.className = 'mixer-row-bot';
    const volIcon = document.createElement('span');
    volIcon.className = 'mixer-row-vol-icon';
    setVolIcon(volIcon, win.vol);
    wireVolIcon(volIcon, () => toggleWinMute(win));
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '100';
    vol.value = String(Math.round((win.vol != null ? win.vol : WIN_VOLUME_DEFAULT) * 100));
    vol.className = 'mixer-row-vol';
    vol.title = 'この枠の音量';
    vol.addEventListener('input', () => setWinVol(win, Number(vol.value) / 100));
    vol.addEventListener('change', onWinVolCommitted);
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
      if (!h || panel.dataset.userResized) return;
      panel.style.height = h + 'px';
      // 自動表示が先に置いていたら、伸びたぶん位置がずれるので置き直す。
      if (!panel.hidden && !panel.dataset.pinned) placeMixer(panel);
    });
  } catch (e) { /* noop */ }
  document.getElementById('mixer-close').addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('mixer-btn').addEventListener('click', () => {
    if (panel.hidden) openMixer(); else panel.hidden = true;
  });
  ['master-vol-icon', 'mixer-master-icon'].forEach((id) => wireVolIcon(document.getElementById(id), toggleMasterMute));
  const mm = document.getElementById('mixer-master');
  mm.addEventListener('input', () => { setMasterVolume(Number(mm.value) / 100); syncMasterUI(); });
  mm.addEventListener('change', () => saveLineup());
}

// 枠一覧を開く(最前面へ置き直し、中身を最新にしてから出す)。
// 一覧ボタン(右下の丸ボタン)・最初の枠ができた時の自動表示で共用する。
function openMixer() {
  const panel = document.getElementById('mixer-panel');
  if (!panel) return;
  panel.hidden = false;
  raisePanel(panel);
  syncMasterUI();
  renderMixer();
  delete panel.dataset.pinned;
  placeMixer(panel); // 行数で高さが変わるので、中身を作ってから置く
}

function placeMixer(panel) {
  if (stackMode) centerPanel(panel);
  else placePanelClear(panel);
}
