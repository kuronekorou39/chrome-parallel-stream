// 枠の並びの保存・復元と、名前付きレイアウト。

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
      max: !!w.maximized, vol: w.vol != null ? w.vol : 1, hidden: !!w.hidden && !w.autoHidden, light: !!w.light, // 自動で隠した枠は、隠したまま保存すると読み込まれず再開に気づけない
      tall: w.tall == null ? null : !!w.tall, // 縦積みタイル高の手動指定(null=既定の16:9)
      span: w.span === 'half' ? 'half' : 'full', // 縦積みタイル幅(100%/50%)
      zoom: w.zoom, // 枠内サイトの縮小率の手動指定(🔍。null=幅に応じた既定)
      chat: !!w.chatOn, // チャット列を出すか(枠ごと。既定は全体設定から)
      dmk: { on: !!w.danmaku.on, overrides: w.danmaku.overrides || {} } // 弾幕のON/OFFと枠ごと上書き設定
    };
  });
}

function saveLineup() {
  if (restoring) return;
  try {
    MV.storage.local.set({
      [MULTIVIEW_ACTIVE_KEY]: {
        wins: currentLineupItems(),
        masterVolume,
        danmakuGlobal: dmkGlobal,
        // 全体の既定(次に追加される枠へ適用する)。枠ごとの状態は wins 側に入っている。
        defaults: { danmaku: danmakuDefaultOn, chat: chatDefaultOn },
        timestamp: new Date().toISOString()
      }
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
    // 枠ごとのチャット表示は保存値を優先(全体の既定より、その枠で選んだ状態を尊重する)。
    if (typeof it.chat === 'boolean') win.chatOn = it.chat;
    syncChatVisibility(win); // 弾幕ONなら、畳んでいても取得元として生かす
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
  stopAutoLayout(); // 呼び出した配置を、自動で崩さない
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
    putLabel(del, ':trash:');
    del.addEventListener('click', async (e) => { e.stopPropagation(); await deleteLayout(lo.id); renderLayoutList(); });
    item.appendChild(main);
    item.appendChild(del);
    list.appendChild(item);
  });
}
