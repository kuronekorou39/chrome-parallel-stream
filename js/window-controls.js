// 枠ごとの操作(映像調整・⋮メニュー・縮小・全画面)。

// 各枠ヘッダの 🎨 から開く「この枠だけ」の調整パネル(透明度・明るさ・コントラスト・彩度)。
function buildAdjustPanel(win) {
  const panel = document.createElement('div');
  panel.className = 'win-adjust';

  // 他の浮動パネル(枠一覧・弾幕設定)と同じ「名前 + ✕」のヘッダ。⋮メニューから開いた後、
  // 閉じ方が ⋮ を開き直すしかないと分かりづらいので、その場で閉じられるようにする。
  const head = document.createElement('div');
  head.className = 'adj-head';
  const title = document.createElement('span');
  title.className = 'adj-title';
  putLabel(title, ':adjust: 映像調整');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'adj-x';
  close.textContent = '✕';
  close.title = '閉じる';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    win.el.classList.remove('adjust-open');
  });
  head.append(title, close);
  // ヘッダを掴んで枠の中で移動できる(他の浮動パネルと同じ makePanelDraggable)。
  // 見たいところに被ったまま調整するしかない、という状態にしないため。
  makePanelDraggable(panel, head);

  const mkRow = (label, min, max, value, oninput) => {
    const row = document.createElement('label');
    row.className = 'adj-row';
    const span = document.createElement('span');
    putLabel(span, label);
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
  const rBright = mkRow(':sun: 明るさ', 20, 200, win.filter.bright, (v) => {
    win.filter.bright = v;
    applyFilter(win);
  });
  const rContrast = mkRow(':contrast: コントラスト', 20, 200, win.filter.contrast, (v) => {
    win.filter.contrast = v;
    applyFilter(win);
  });
  const rSat = mkRow(':drop: 彩度', 0, 200, win.filter.sat, (v) => {
    win.filter.sat = v;
    applyFilter(win);
  });

  // 遅延(Twitch のライブのみ)。音合わせは耳で少しずつ詰めるので、スライダーではなく
  // 0.1 秒 / 1 秒刻みのボタンにする(スライダーだと 0.1 秒を狙って動かせない)。
  const delayRow = document.createElement('div');
  delayRow.className = 'adj-row adj-delay';
  const delayLabel = document.createElement('span');
  putLabel(delayLabel, ':clock: 遅延');
  const delayValue = document.createElement('output');
  delayValue.className = 'adj-delay-value';
  const mkStep = (text, step, tip) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = tip;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (step === 0) win.delayHold = false; // 「0」は固定も解いて、プレイヤー任せに戻す
      setWinDelay(win, step === 0 ? 0 : win.delay + step);
    });
    return b;
  };
  delayRow.append(
    delayLabel,
    mkStep('−1', -1, '1 秒早める'),
    mkStep('−0.1', -0.1, '0.1 秒早める'),
    delayValue,
    mkStep('+0.1', 0.1, '0.1 秒遅らせる'),
    mkStep('+1', 1, '1 秒遅らせる'),
    mkStep('0', 0, '遅延をやめる(位置の固定も解く)')
  );
  win.syncDelayUI = () => {
    delayRow.hidden = !delaySupported(win);
    delayValue.textContent = win.delay.toFixed(2) + ' 秒';
    // 枠の中で実際に付いた量が指定に届くまでは「調整中」。大きく動かした直後や、
    // 読み直しで遅延を溜め直している間がこれに当たる。
    const st = win.delayState;
    const pending = win.delay > 0 && !(st && st.target === win.delay && st.settled);
    delayValue.classList.toggle('pending', pending);
    delayValue.title = pending
      ? '調整中(いま ' + (st ? st.actual.toFixed(1) : '0.0') + ' 秒)'
      : (win.delayHold ? '音で合わせた位置に固定中(「0」で解除)' : '');
  };
  win.syncDelayUI();

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

  panel.append(head, rOpacity.row, rBright.row, rContrast.row, rSat.row, delayRow, reset);
  return panel;
}

// 🎨 パネルの開閉(同時に1枠だけ開く)。
function toggleAdjust(win) {
  const willOpen = !win.el.classList.contains('adjust-open');
  wins.forEach((w) => w.el.classList.remove('adjust-open'));
  if (willOpen) {
    win.el.classList.add('adjust-open');
    if (win.syncDelayUI) win.syncDelayUI(); // 映しているものが変わっていれば、遅延の行の出し分けも変わる
  }
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
    putLabel(b, label);
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
      // その場で切り替わる項目はメニューを開いたままにする。閉じてしまうと、結果を見て
      // 戻したいときに開き直す手間がかかる(幅・高さと挙動を揃える)。
      // 別のパネルを開く項目(弾幕の設定など)は mkItem 側で閉じる。
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

  // 使う頻度と目的で3つに束ねる。上から「見ている最中に触るもの」「見え方の設定」「弾幕」。
  // 最後に、枠から出る操作を置く。

  const mkRow = (cls) => {
    const r = document.createElement('div');
    r.className = 'win-menu-row' + (cls ? ' ' + cls : '');
    menu.appendChild(r);
    return r;
  };
  const mkIcon = (row, label, title, fn, keepOpen) => {
    const b = document.createElement('button');
    b.type = 'button';
    putLabel(b, label);
    b.title = title;
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (!keepOpen) closeMenu();
      fn();
    });
    row.appendChild(b);
    return b;
  };

  // ① 見え方。幅/高さは縦積み専用の効果しか持たないため、PC(自由配置)では
  // syncMenuModeVisibility が行ごと隠す(軽量はPCでも機能するので残す)。
  // トグル表示にして、いま出ているのか隠れているのかが分かるようにする。
  if (win.chatFrame) win.menuChat = mkToggle(() => toggleChat(win));
  // 映像調整はスマホでは出さない(小さい画面でそこまで詰める場面が無く、行数だけ増える)。
  win.menuAdjust = mkItem(':adjust: 映像調整', () => toggleAdjust(win));
  win.menuAdjust.classList.add('pc-only');
  // 軽量/通常の切替はメニューに置かない。何を映しているか(一覧か、配信そのものか)で
  // 決まる話で、利用者が選ぶ場面が無いため。一覧から配信を選べば自動で切り替わり、
  // 「← 戻る」で一覧へ帰れば自動で戻る。
  // 幅と高さは2択ずつなので値は出さない。並びは他の項目と揃えて縦に積む
  // (横並びにすると、ここだけ操作の形が違って浮く)。
  // メニューは開いたままにする(並べ方を決めるのに何度か押して見比べるため)。
  win.menuSizeRow = mkRow('stack-only col');
  win.menuSpan = mkIcon(win.menuSizeRow, ':width: 幅', '枠の幅を切り替える', () => toggleSpan(win), true);
  win.menuTall = mkIcon(win.menuSizeRow, ':height: 高さ', '枠の高さを切り替える', () => toggleTall(win), true);
  // 並び替え。長押しドラッグは指の動きに左右されて安定しないので、確実に効く手段を用意する。
  win.menuUp = mkIcon(win.menuSizeRow, ':up: 上へ', 'ひとつ上へ移動', () => moveWin(win, -1), true);
  win.menuDown = mkIcon(win.menuSizeRow, ':down: 下へ', 'ひとつ下へ移動', () => moveWin(win, 1), true);
  mkSep();

  // ② 弾幕。on は永続なので保存。
  // Kick も 0.9.54 で content script が入り、チャットを読めるようになったので対象に含める。
  win.menuDanmaku = mkToggle(() => { toggleDanmaku(win); saveLineup(); });
  mkItem(':gear: 弾幕の設定', () => openDanmakuPanel(win)); // この枠を対象に設定パネルを開く
  mkSep();

  // ③ 基本操作は説明が要らないので、ラベルを外してアイコンだけの1行にまとめる。
  // 項目を縦に並べると、画面の小さいスマホではそれだけでメニューが伸びて押しにくい。
  // 「戻る」は履歴が無い間は押せない(押しても何も起きないボタンは置かない)。
  const opRow = mkRow();
  win.menuBack = mkIcon(opRow, ':back:', '枠の中で1つ前のページへ戻る', () => goBackWindow(win));
  mkIcon(opRow, ':reload:', 'この枠を再読込', () => reloadWindow(win));
  mkIcon(opRow, ':fullscreen:', '全画面で操作', () => toggleStackMax(win));
  mkIcon(opRow, ':external:', '元サイトを新しいタブで開く', () => openOriginal(win));
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
// 並び順をひとつ動かす(縦積みの表示順)。隠している枠は飛ばして、見えている並びで動かす。
function moveWin(win, dir) {
  const vis = wins.filter((w) => !w.hidden);
  const i = vis.indexOf(win);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= vis.length) return;
  const from = wins.indexOf(win);
  const to = wins.indexOf(vis[j]);
  wins.splice(from, 1);
  wins.splice(to, 0, win);
  relayoutStack();
  saveLineup();
  renderMixer();
  wins.forEach((w) => syncMenuLabels(w)); // 端に来たら押せなくする
}

function syncMenuModeVisibility(win) {
  // 幅・高さは行ごと出し入れする(中のボタンを個別に隠すと行だけが残る)。
  if (win.menuSizeRow) win.menuSizeRow.style.display = stackMode ? '' : 'none';
}
function syncMenuLabels(win) {
  if (win.menuBack) {
    const ok = canGoBack(win);
    win.menuBack.disabled = !ok;
    win.menuBack.title = ok ? '枠の中で1つ前のページへ戻る' : '戻れるページがありません';
  }
  if (win.menuChat) {
    const usable = hasChatContent(win);
    const on = !!win.chatOn; // 「出す設定か」。実際に見えているかは枠の大きさにもよる(下の cramped)
    // 「表示」のまま枠が小さくて自動で畳んでいる状態。値は変えず(広げれば戻るので)、
    // 出ていない理由が分かるように説明だけ差し替える。
    const cramped = usable && on && win.el.classList.contains('cq-hide-chat');
    putLabel(win.menuChat.name, ':chat: チャット');
    win.menuChat.btn.disabled = !usable;
    win.menuChat.val.textContent = !usable ? 'なし' : on ? '表示' : '非表示';
    win.menuChat.btn.classList.toggle('on', usable && on);
    win.menuChat.btn.title = !usable
      ? win.light === false
        ? '通常表示ではサイト側のチャットを使います'
        : 'この配信にはチャットがありません'
      : cramped
        ? '枠が小さいので今は畳んでいます(枠を広げると出ます)'
        : 'タップで ' + (on ? '非表示' : '表示') + ' に切替';
  }
  if (win.menuUp || win.menuDown) {
    const vis = wins.filter((w) => !w.hidden);
    const i = vis.indexOf(win);
    if (win.menuUp) win.menuUp.disabled = i <= 0;
    if (win.menuDown) win.menuDown.disabled = i < 0 || i >= vis.length - 1;
  }
  // 幅・高さは2択ずつなのでボタンだけ。いま選ばれている側を色で示す。
  if (win.menuTall) {
    win.menuTall.classList.toggle('on', isTall(win));
    win.menuTall.title = 'タップで ' + (isTall(win) ? '16:9' : '縦長') + ' に切替';
  }
  if (win.menuSpan) {
    win.menuSpan.classList.toggle('on', win.span === 'half');
    win.menuSpan.title = 'タップで ' + (win.span === 'half' ? '100%(1つ)' : '50%(横に2つ)') + ' に切替';
  }
  if (win.menuDanmaku) {
    putLabel(win.menuDanmaku.name, ':danmaku: 弾幕');
    win.menuDanmaku.val.textContent = win.danmaku.on ? 'ON' : 'OFF';
    win.menuDanmaku.btn.classList.toggle('on', win.danmaku.on);
    win.menuDanmaku.btn.title = 'チャットのコメントを画面に流す(タップで ' + (win.danmaku.on ? 'OFF' : 'ON') + ')';
  }
}

// 枠内シアター(視聴ページで video を枠いっぱいに固定)はスタックモード=スマホ縦積みのとき有効。
// 有効化は親主導で frame へ伝える(iframe 内の pointer:coarse 判定に頼らない)。
function sendTheaterEnabled(win, on) {
  postToFrame(win.frame, { type: 'set-theater-enabled', value: !!on });
}

// ⛶全画面の間だけシアターを止めて素のサイトを操作できるようにする。
function sendTheaterSuspend(win, suspended) {
  postToFrame(win.frame, { type: 'set-theater-suspend', value: !!suspended });
}

// frame の現在あるべきシアター状態をまとめて送る。
// 軽量プレイヤー(embed)はそのままで完成形=シアター不要。むしろ video 移動が embed の自動再生
// 可視性要件を壊して再生が止まるため、軽量枠ではシアターを無効にする。
function syncFrameTheater(win) {
  sendTheaterEnabled(win, stackMode && !win.light);
  if (win.el.classList.contains('stack-max')) sendTheaterSuspend(win, true);
}

// 枠内サイトの縮小率。仮想ビューポートを広げて scale で縮めるので、小さいタイルでも
// サイトの要素が大きすぎず、広い範囲が見えて操作しやすくなる。
// 以前は手動で 100→75→50 と巡回させていたが、枠の幅から決まる話でしかなく、
// 選ばせても迷わせるだけだったのでやめた(保存済みの win.zoom があっても無視する)。
//  - 自由配置(PC)= 等倍100%(縮小は枠のリサイズで足りる。縮小すると Twitch 等が想定外の
//    レイアウトになる)
//  - 縦積み(スマホ)= 幅に合わせて自動。狭いほど縮めて情報量を確保する
function effectiveZoom(win) {
  if (!stackMode) return 100;
  return win.span === 'half' ? ZOOM_DEFAULT_HALF : ZOOM_DEFAULT_FULL;
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
