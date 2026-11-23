// ツールバー・≡メニュー・無操作時の表示制御。

// ====== ツールバー ======

function wireToolbar() {
  const masterSlider = document.getElementById('master-vol');
  masterSlider.addEventListener('input', (e) => {
    setMasterVolume(Number(e.target.value) / 100);
    syncMasterUI(); // ツールバー+ミキサーのアイコン/つまみを同期
  });
  // つまみを離した時に保存(input 連発で storage を叩かないよう change で一度だけ)。
  masterSlider.addEventListener('change', () => saveLineup());
  document.getElementById('tile-btn').addEventListener('click', () => runManualLayout('tile', tileAll));

  // ⚡ 軽量プレイヤー一括切替(押すたびに 全部軽量 ⇄ 全部通常。枠ごとの個別切替はヘッダの⚡)。
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
  // 縦積み(スマホ)だけ下寄せ。タイルが上から積まれるので、中央だと追加した枠にすぐ隠れる。
  const openAdd = (e) => {
    if (e) e.stopPropagation();
    toggleDialog('add-dialog', { place: (panel) => (stackMode ? placePanelBottom(panel) : placePanelClear(panel)) });
  };
  document.getElementById('add-open-btn').addEventListener('click', openAdd);
  document.getElementById('qa-add').addEventListener('click', openAdd); // 右下の丸ボタン(＋)
  document.getElementById('qa-layout').addEventListener('click', openLayoutDialog); // 右下の丸ボタン(配置)
  // 右下の丸ボタン(一覧)。開閉の切替は #mixer-btn と同じ処理に任せる。
  document.getElementById('qa-mixer').addEventListener('click', () => document.getElementById('mixer-btn').click());
  setupQuickButtonState();
  document.getElementById('empty-add-btn').addEventListener('click', openAdd); // 空ステージの大ボタンからも開ける
  setupDialog('add-dialog');

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
      // data-note 付き(Kick / mellow-fan)は枠を作らず、理由を出して URL 欄へ誘導するだけ。
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
  setupDialog('update-dialog');
  setupSyncDialog();
  MV.storage.local.get(TOOLBAR_POS_KEY, (d) => {
    // 読込前にユーザーが位置を選んでいたら、その操作を保存値で巻き戻さない。
    if (!toolbarPosTouched) applyToolbarPos((d && d[TOOLBAR_POS_KEY]) || 'bottom', false);
    requestAnimationFrame(() => document.body.classList.add('tb-ready'));
  });
}

// ====== スマホ用メインメニュー(縦リスト) ======
// スマホ(縦積み)ではツールバーのバー表示をやめ、≡ から右クリックメニュー風の縦リストを出す。
// 項目: 弾幕・チャット・パフォーマンス・ログインCookie(追加・一覧・配置は右下の丸ボタン、音量/並びはミキサー、軽量は各枠のバッジ)。
// 機能は既存ツールバーボタンを programmatic click して呼ぶ(状態・ロジックの二重化を避ける)。

// ≡メニューの「弾幕」「チャット」に現在の全体既定を出す(値 + ON のときは緑)。
function syncMainMenuToggles() {
  const set = (id, valId, on, onText, offText) => {
    const btn = document.getElementById(id);
    const val = document.getElementById(valId);
    if (!btn || !val) return;
    val.textContent = on ? onText : offText;
    btn.classList.toggle('on', on);
    btn.title = '全部の枠をまとめて切り替え、これから追加する枠の既定にもする';
  };
  set('mm-danmaku-all', 'mm-danmaku-all-val', danmakuDefaultOn, 'ON', 'OFF');
  set('mm-chat-all', 'mm-chat-all-val', chatDefaultOn, '表示', '非表示');
}

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
  // PC は出しっぱなしにする(連続で複数のパネルを開けるほうが速い)。
  // スマホは画面が狭く、開いたメニューが下のパネルや枠を覆ってしまうので、選んだら閉じる。
  const act = (id, fn) =>
    mkAct(id, () => {
      if (stackMode) toggleMainMenu(false);
      fn();
    });
  // 弾幕/チャットは全枠まとめて切り替え、そのまま次に追加する枠の既定にもなる。
  // 押しても閉じない(見比べながら両方を切り替えることが多いため)。
  mkAct('mm-danmaku-all', () => setAllDanmaku(!danmakuDefaultOn));
  mkAct('mm-chat-all', () => setAllChat(!chatDefaultOn));
  act('mm-sync', openSyncDialog); // 説明のダイアログを挟む(実行はその中のボタンから)
  mkAct('mm-sync-auto', () => setSyncAuto(false)); // オンの間だけ出る。押すと定期実行を止める
  act('mm-perf', () => document.getElementById('perf-btn').click());
  act('mm-danmaku', () => openDanmakuPanel(null)); // 全体対象で弾幕設定パネルを開く
  act('mm-cookie', openCookieDialog);
  act('mm-update', openUpdateDialog);
  // 透明バックドロップ: メニュー外のタップは「閉じる」だけで、下のタイルへは絶対に流さない。
  document.getElementById('main-menu-backdrop').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMainMenu(false);
  });
}

// ポインタが一定時間動かなかったら、まずカーソル+常駐UI(≡メニュー/⛶全画面を終了)を消し(IDLE_CURSOR_MS)、
// さらに操作が無ければツールバー本体も畳む(TOOLBAR_HIDE_MS。すぐ消えると使いづらいので長めに残す)。
// 「カーソルと一緒に ≡ も消す」は body.idle に相乗りした CSS が担当(multiview.css の body.idle ルール)。
// マウス/指を動かすと arm() が即 body.idle を外し、カーソルと ≡/全画面終了ボタンが戻る(= 動かしている間は表示)。
// 一方ツールバー本体(toolbar-hidden)は時間で畳んだら、戻すのは ≡ を押した時だけ(勝手に出さない)。
// 無操作が続いたら「追加」「配置」を閉じる。一覧はよく使うので残す。
// 入力欄で文字を打っている間はポインタが動かないので、そのダイアログは閉じない。
function closeIdleDialogs() {
  const focused = document.activeElement;
  ['add-dialog', 'layout-dialog'].forEach((id) => {
    const dlg = document.getElementById(id);
    if (!dlg || (dlg.contains(focused) && focused.matches('input'))) return;
    dlg.classList.remove('open');
  });
}

function setupIdleHide() {
  const toolbar = document.getElementById('toolbar');
  let cursorTimer = null;
  let toolbarTimer = null;
  let idle = false;
  // body.idle(カーソル+常駐UIを消す)はトップ文書にしか効かない。枠(iframe)の上のカーソルは iframe 側の
  // 文書が管理するので、idle の変化を各 frame へ通知して中のカーソルも消す/戻す(stream-control が set-idle を処理)。
  const broadcastIdle = (on) => {
    wins.forEach((w) => {
      [w.frame, w.chatFrame].forEach((f) => postToFrame(f, { type: 'set-idle', value: on }));
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
    // 消えると pointer-events が切れて :hover も外れるので、消す前に見ておく。
    const hovered = openClearPanels().filter((el) => el.matches(':hover'));
    setIdle(true);
    setTimeout(() => { if (idle) avoidPanels(hovered); }, PANEL_MOVE_AFTER_FADE_MS);
    // 枠の ✕ / ⋮ も一緒に引っ込める。これらは show-bar / menu-open が付いている間ずっと
    // 出るので、枠を触った直後に別の枠へ移ったり、⋮ を開いたまま放置したりすると
    // 出しっぱなしになっていた。無操作になったら枠側の表示状態もまとめて落とす。
    wins.forEach((w) => {
      w.el.classList.remove('show-bar', 'menu-open');
      clearTimeout(w.barTimer);
    });
  };
  const hideToolbar = () => {
    if (toolbar.matches(':hover')) return;
    // 開いている ≡ メニューも一緒に畳む。ツールバーと ≡ ボタンだけ消えてメニューが残ると、
    // 出所の分からない板が画面に浮いたままになる。
    toggleMainMenu(false);
    closeIdleDialogs();
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
