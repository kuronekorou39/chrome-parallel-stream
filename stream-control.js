// 配信サイトが iframe 内(= multiview のタイル)で読まれたときに動く content script。
// 役割:
//   1. 起動直後だけフレーム内の <video> を全ミュート(轟音防止)。
//   2. 親(multiview)からの「音量設定」指示で全 <video> の volume と muted を維持する
//      (音はスライダーが所有。スマホ縦積みではプレイヤーUIに触れないため、これが唯一の音導線)。
//   3. Twitch のみ: シアターモードを1回 click して player を最大化。
// 最上位タブ(通常閲覧)では何もしない。

// 自分の枠(multiview)の中でだけ動かす。「iframe の中かどうか」だけで判定すると、無関係なサイトが
// 配信ページを埋め込んでいる場合にもこのスクリプトが動き、フレームの URL やポインタのスクリーン座標を
// その相手サイトへ postMessage で渡してしまう(通常はクロスオリジンで取得できない情報)。
// 最上位の祖先オリジンが multiview のページ(ホスト版 or 拡張ページ)のときだけ動かす。
// なお他拡張のページ内フレームには他拡張の content script は注入されないため、
// 祖先が chrome-extension:// なら、それは自分の拡張ページだと判断してよい。
const MV_HOST_ORIGIN = 'https://kuronekorou39.github.io';
function mvInOwnFrame() {
  try {
    const a = location.ancestorOrigins;
    if (!a || a.length === 0) return false;
    const top = a[a.length - 1];
    return top === MV_HOST_ORIGIN || top.indexOf('chrome-extension://') === 0;
  } catch (e) {
    return false;
  }
}

(function streamControl() {
  if (window.top === window.self) return; // iframe 内のみ動作
  if (!mvInOwnFrame()) return; // multiview の枠でないなら何もしない
  const MAGIC = '__multiviewControl';
  const host = location.hostname;

  // ---- 音声: 起動直後だけ全ミュート ----
  function muteAll() {
    const vids = document.querySelectorAll('video');
    for (const v of vids) {
      try { v.muted = true; } catch (e) { /* noop */ }
    }
  }

  // 起動時にミュート。遅延ロードの <video> も拾うため数回だけ追いがけし、その後は止める。
  // 継続監視はしない(ユーザーがプレイヤー自前でミュート解除したのを巻き戻さないため)。
  muteAll();
  [300, 1200, 2500].forEach((ms) => setTimeout(muteAll, ms));

  // 親(multiview.html)からの「この枠の実音量」指示(value: 0〜1 = 枠ごと音量 × マスタ)。
  // 枠ごと音量とマスタの掛け算は親側で済ませて effective を送ってくるので、ここはそれを全 video に
  // 当てて維持するだけ。Twitch等は内蔵スライダーが video.volume を動かさない(Web Audio 経由)ため、
  // 確実に効く video.volume をこちらで当て続ける(= 親の指定値を強制)。
  // muted もスライダーが所有する(>0 で解除 / 0 でミュート)。スマホの縦積みではシールドにより
  // プレイヤーUIへ触れないため、親のスライダーだけで音が出る/消えることを保証する。
  // 「1つだけ聞く」は他の枠の音量を 0 にして行う(プレイヤー自前のミュートには頼らない)。
  let mvVolume = null; // null = まだ未受信
  function applyVol() {
    if (mvVolume === null) return;
    const wantMuted = mvVolume <= 0;
    document.querySelectorAll('video').forEach((v) => {
      try {
        if (Math.abs(v.volume - mvVolume) > 0.005) v.volume = mvVolume;
        if (v.muted !== wantMuted) v.muted = wantMuted;
      } catch (err) { /* noop */ }
    });
  }

  // ---- 枠内シアター(スマホでは常時自動) ----
  // 視聴ページではページ内の主要 <video> を枠いっぱいに固定表示し、ページスクロールを封じる。
  // 大きな video が無いページ(一覧など)では何もしないので、ブラウズはそのまま。
  // 下の「シアターモード click」はデスクトップ版Twitch専用(モバイル版にはボタンが無い)ため、
  // モバイルはこちらが担当する。⛶全画面中は親から suspend が来て、素のサイト操作に戻る。
  // シアターの有効化は親(multiview)主導。親はスタックモード(スマホ縦積み)かどうかを確実に
  // 知っているため、iframe 内の pointer:coarse 判定(環境で不安定)には頼らない。
  let theaterOn = false; // 親から set-theater-enabled が来たら true
  let theaterSuspended = false; // ⛶全画面中の一時停止
  let theaterEl = null;   // シアター中の対象 video / iframe
  let theaterWrap = null; // 対象 video を入れる全画面オーバーレイ(html 直下=transform 付き祖先の外)
  let theaterHome = null; // 対象の元の位置 { parent, next }。解除時に戻す
  let theaterReported = null; // 親へ通知済みの状態(枠バッジ診断用)
  // state: 'on'=動画を固定中 / 'searching'=有効だが主映像が見つからない / 'off'=無効。
  function reportTheater(state) {
    if (theaterReported === state) return;
    theaterReported = state;
    try {
      window.parent.postMessage({ [MAGIC]: true, type: 'theater-state', state }, '*');
    } catch (e) { /* noop */ }
  }
  // 固定対象 = ページ内の主要メディア。まず大きな <video>、無ければ「プレイヤーらしい iframe」
  // (モバイル版サイトは動画を子フレームに置く構造があり、外側ページに video が無いため)。
  function findMainMedia() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.5 && r.width * r.height > bestArea) {
        best = v;
        bestArea = r.width * r.height;
      }
    });
    if (best) return best;
    document.querySelectorAll('iframe').forEach((f) => {
      const src = f.getAttribute('src') || '';
      const allow = f.getAttribute('allow') || '';
      if (!(/player\.|\/embed\/|ivs\./i.test(src) || /autoplay/i.test(allow))) return; // プレイヤー風のみ
      const r = f.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.5 && r.height >= window.innerHeight * 0.2 && r.width * r.height > bestArea) {
        best = f;
        bestArea = r.width * r.height;
      }
    });
    return best;
  }
  // 対象を元の位置・スタイルへ戻す(オーバーレイは撤去)。
  function restoreTheaterEl() {
    if (theaterEl) {
      ['position', 'left', 'top', 'width', 'height', 'object-fit', 'z-index', 'background', 'border']
        .forEach((p) => theaterEl.style.removeProperty(p));
      if (theaterHome && theaterHome.parent && theaterHome.parent.isConnected) {
        try {
          if (theaterHome.next && theaterHome.next.parentNode === theaterHome.parent) {
            theaterHome.parent.insertBefore(theaterEl, theaterHome.next);
          } else {
            theaterHome.parent.appendChild(theaterEl);
          }
        } catch (e) { /* noop */ }
      }
    }
    if (theaterWrap) { try { theaterWrap.remove(); } catch (e) { /* noop */ } theaterWrap = null; }
    theaterEl = null;
    theaterHome = null;
  }
  function clearTheaterAll() {
    restoreTheaterEl();
    document.documentElement.style.removeProperty('overflow');
    if (document.body) document.body.style.removeProperty('overflow');
    reportTheater(theaterOn && !theaterSuspended ? 'searching' : 'off');
  }
  function fillStyle(el) {
    const s = el.style;
    s.setProperty('width', '100%', 'important');
    s.setProperty('height', '100%', 'important');
    s.setProperty('max-width', 'none', 'important');
    s.setProperty('max-height', 'none', 'important');
    s.setProperty('object-fit', 'contain', 'important');
    s.setProperty('background', '#000', 'important');
    s.setProperty('border', '0', 'important');
  }
  function applyTheater() {
    if (!theaterOn || theaterSuspended) return;
    const m = findMainMedia();
    if (!m) { clearTheaterAll(); return; } // 視聴ページ以外では何もしない

    if (theaterEl !== m) {
      if (theaterEl) restoreTheaterEl(); // 対象が替わった(SPA遷移/プレイヤー再生成)
      theaterEl = m;
      theaterHome = { parent: m.parentNode, next: m.nextSibling };
    }

    if (m.tagName === 'VIDEO') {
      // <video> はオーバーレイ(html 直下)へ移動する。これで transform 付き祖先があっても
      // 確実に全画面化でき、ページのどこがスクロールしても上を覆う。再生は途切れない(MSE 維持)。
      if (!theaterWrap || !theaterWrap.isConnected) {
        theaterWrap = document.createElement('div');
        theaterWrap.setAttribute('data-mv-theater', '');
        theaterWrap.style.cssText =
          'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;background:#000;margin:0;padding:0;';
        document.documentElement.appendChild(theaterWrap);
      }
      if (m.parentNode !== theaterWrap) theaterWrap.appendChild(m);
      fillStyle(m);
    } else {
      // <iframe> は DOM 移動するとリロードされるため、その場で固定する。
      const s = m.style;
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('left', '0', 'important');
      s.setProperty('top', '0', 'important');
      s.setProperty('width', '100vw', 'important');
      s.setProperty('height', '100vh', 'important');
      s.setProperty('z-index', '2147483647', 'important');
      s.setProperty('background', '#000', 'important');
      s.setProperty('border', '0', 'important');
    }
    // スクロールは html と body の両方で封じる(サイトによりスクロール主体が異なるため)。
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    if (document.body) document.body.style.setProperty('overflow', 'hidden', 'important');
    reportTheater('on');
  }
  // サイト側の上書きや SPA 遷移に追従して当て直す(OFF の間は何もしない)。
  setInterval(applyTheater, 1000);

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return; // 親以外からの偽装を弾く
    const d = e.data;
    if (!d || d[MAGIC] !== true) return;
    if (d.type === 'set-volume') {
      mvVolume = Math.max(0, Math.min(1, Number(d.value)));
      applyVol();
    } else if (d.type === 'set-theater-enabled') {
      // 親(スタックモード)からのシアター有効/無効。
      theaterOn = d.value === true;
      if (theaterOn) applyTheater();
      else clearTheaterAll();
    } else if (d.type === 'set-theater-suspend') {
      // ⛶全画面の間はシアターを止め、素のサイトを操作できるようにする(解除で自動復帰)。
      theaterSuspended = d.value === true;
      if (theaterSuspended) clearTheaterAll();
      else applyTheater();
    } else if (d.type === 'set-danmaku-enabled') {
      // 親(multiview)からの弾幕 ON/OFF。ON の間だけチャットDOMを監視して新着コメントを親へ送る。
      danmakuSetEnabled(d.value === true);
    }
  });

  // 起動時に親へ挨拶し、現在のシアター設定(有効/全画面中)を送り返してもらう。
  // content script 注入と親のフレーム load イベントのすれ違いで設定を取りこぼさないため。
  try {
    window.parent.postMessage({ [MAGIC]: true, type: 'frame-hello' }, '*');
  } catch (e) { /* noop */ }

  // プレイヤーの上書きや、遅延ロード/SPA遷移で現れた新しい video にも、親の指定値を当て続ける。
  // (枠ごと音量は 🎨 パネルで操作する設計なので、これで取り違え・戻し問題は起きない)
  setInterval(applyVol, 1000);
  // YouTube はプレイヤーが video.volume を周期的に大きめ(自分の記憶値)へ戻すことがあり、1秒ポーリングだと
  // 戻すまでの間だけ音量が跳ね上がって聞こえる(特にスマホ)。volumechange/play を捕捉して即座に親指定値へ
  // 当て直す。音量/ミュートを当てるだけで play() は呼ばないので、再生ループや churn は起こさない。
  // Twitch(IVS/Web Audio)は video.volume を音量制御に使わず干渉の恐れがあるため対象外、YouTube 限定。
  if (host.includes('youtube.com')) {
    const fixVol = (v) => {
      if (mvVolume === null || !v || v.tagName !== 'VIDEO') return;
      const wantMuted = mvVolume <= 0;
      try {
        if (Math.abs(v.volume - mvVolume) > 0.005) v.volume = mvVolume;
        if (v.muted !== wantMuted) v.muted = wantMuted;
      } catch (e) { /* noop */ }
    };
    ['volumechange', 'play', 'playing'].forEach((ev) =>
      document.addEventListener(ev, (e) => fixVol(e.target), true)); // capture=非バブルのメディアイベントも拾う
  }

  // ---- 長押し → 親へ「このタイルを掴んだ」を中継(縦積みのドラッグ並び替え用) ----
  // サイト内の通常タップ・クリック・スクロールには一切干渉しない(静止 LP_MS で発火、動けば不成立)。
  // 座標は screen 系で送る(ドラッグでタイルごと iframe が動いても screen 座標はぶれないため)。
  // しきい値は親(multiview.js)の LONG_PRESS_MS / LONG_PRESS_SLOP と感覚を合わせること。
  const LP_MS = 450;
  const LP_SLOP = 10;
  let lpTimer = null;
  let lpDown = null; // { sx, sy, cx, cy } 押下時の screen / クライアント座標
  let lpDragging = false;
  let lpEndedAt = 0; // ドラッグ直後の click 誤発火(リンク踏み)抑止用
  let rmbDown = null; // 右ボタンのドラッグ用(マウスのみ)。押下時の screen 座標。動かしたら即つかむ=長押し不要
  let lpPid = null;   // ドラッグ中のポインタID(キャプチャの解放に使う)
  const post = (type, extra) => {
    try {
      window.parent.postMessage(Object.assign({ [MAGIC]: true, type }, extra || {}), '*');
    } catch (e) { /* noop */ }
  };

  // ドラッグ開始時にこの文書でポインタを捕捉する。捕捉しないと、離した瞬間にカーソルが
  // このフレームの外(枠の外や、サイト内の入れ子 iframe の上)にあると pointerup が届かず、
  // lpDragging が true のまま残る。そうなると selectstart を抑止し続けるので、文字選択も
  // 入力欄へのフォーカスもできなくなり、親へ tile-drag-end も飛ばないので枠が掴まれたままになる。
  const capturePointer = (pid) => {
    lpPid = pid;
    try { document.documentElement.setPointerCapture(pid); } catch (e) { /* noop */ }
  };
  // 枠の移動(長押し / 右ドラッグ)を扱うのは、multiview の直下のフレームだけにする。
  // サイト内の入れ子フレーム(YouTube の live_chat 等)でも動かすと、そこでの押下が長押し判定に
  // 入って選択を抑止してしまう。しかも post 先は multiview ではなくサイト自身なので意味も無い。
  const isDirectTile = window.parent === window.top;

  // 入力欄の上では移動操作を始めない。押している間 selectstart を抑止するため、
  // contenteditable ではキャレットを置けなくなり、文字が打てなくなる
  // (YouTube ライブのチャット入力がこれ。<input> は focus が別扱いなので影響が出にくい)。
  const isEditable = (el) => {
    try {
      return !!(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    } catch (e) {
      return false;
    }
  };

  window.addEventListener('pointerdown', (e) => {
    if (!isDirectTile || isEditable(e.target)) return;
    if (e.pointerType === 'mouse' && e.button === 2) { // 右ボタン: 動かせば即つかんで移動(長押し不要)。右クリックメニューは出さない。
      rmbDown = { sx: e.screenX, sy: e.screenY };
      lpDragging = false;
      post('tile-raise'); // ドラッグ前でも、右クリックした枠を即座に最前面へ
      return;
    }
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.shiftKey) { // Shift+クリック = 親へ「この枠を複数選択にトグル」(サイトには通さない)
      try { e.preventDefault(); } catch (_) { /* noop */ }
      post('tile-shift-click');
      return; // 長押し検知は始めない
    }
    lpDown = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY };
    lpDragging = false;
    clearTimeout(lpTimer);
    const pid = e.pointerId;
    lpTimer = setTimeout(() => {
      if (!lpDown) return;
      lpDragging = true;
      capturePointer(pid);
      post('tile-drag-start', lpDown);
    }, LP_MS);
  }, true); // capture: サイト側が stopPropagation しても拾う
  window.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
    // 右ボタンを押したまま動かしたら、その時点でドラッグ開始(現在位置を始点にしてジャンプを防ぐ)。
    if (rmbDown && !lpDragging && (Math.abs(e.screenX - rmbDown.sx) > LP_SLOP || Math.abs(e.screenY - rmbDown.sy) > LP_SLOP)) {
      lpDragging = true;
      capturePointer(e.pointerId);
      post('tile-drag-start', { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY });
    }
    if (lpDragging) {
      post('tile-drag-move', { sx: e.screenX, sy: e.screenY });
      return;
    }
    if (lpDown && (Math.abs(e.screenX - lpDown.sx) > LP_SLOP || Math.abs(e.screenY - lpDown.sy) > LP_SLOP)) {
      clearTimeout(lpTimer); // 動いた → スクロール/通常操作なので長押し不成立
      lpDown = null;
    }
  }, true);
  const lpEnd = () => {
    clearTimeout(lpTimer);
    lpDown = null;
    rmbDown = null;
    if (lpPid !== null) {
      try { document.documentElement.releasePointerCapture(lpPid); } catch (e) { /* 既に解放済み */ }
      lpPid = null;
    }
    if (lpDragging) {
      lpDragging = false;
      lpEndedAt = Date.now();
      post('tile-drag-end');
    }
  };
  window.addEventListener('pointerup', lpEnd, true);
  window.addEventListener('pointercancel', lpEnd, true);
  window.addEventListener('lostpointercapture', lpEnd, true); // 捕捉を奪われた場合も終了扱いにする
  // 最後の保険。何らかの理由でポインタイベントが途切れても、抑止状態を残さない。
  // ここが残ると文字選択も入力欄へのフォーカスもできなくなるため、必ず解除する。
  // blur では終わらせない(ドラッグ中に枠の外へフォーカスが移ることがあり、誤って中断してしまう)。
  const LP_WATCHDOG_MS = 5000;
  let lpLastEvent = 0;
  setInterval(() => {
    if (!lpDragging && !lpDown && !rmbDown) return;
    if (Date.now() - lpLastEvent < LP_WATCHDOG_MS) return;
    lpEnd();
  }, 1000);
  window.addEventListener('pointermove', () => { lpLastEvent = Date.now(); }, { capture: true, passive: true });
  window.addEventListener('pointerdown', () => { lpLastEvent = Date.now(); }, { capture: true, passive: true });
  // ドラッグ中はサイト側のスクロール・テキスト選択・長押しメニューを抑止し、離した直後の click も無効化。
  window.addEventListener('touchmove', (e) => {
    if (lpDragging && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  // 長押し待ち中(lpDown)から抑止する。成立(lpDragging)を待つと、待つ間のわずかな移動で先に
  // 選択や選択メニューが始まってしまい、ドラッグ移動後も選択が残る。押している間は選択/メニュー/D&Dを止める。
  // 右クリックは「枠の移動」操作に割り当てたため、枠内では常にブラウザのコンテキストメニューを出さない。
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); }, true);
  // 入力欄の上では抑止しない(contenteditable はキャレットを置く操作自体が選択のため、
  // 抑止すると文字が打てなくなる)。
  window.addEventListener('selectstart', (e) => {
    if ((lpDragging || lpDown) && !isEditable(e.target)) e.preventDefault();
  }, true);
  window.addEventListener('dragstart', (e) => {
    if ((lpDragging || lpDown) && !isEditable(e.target)) e.preventDefault();
  }, true); // リンク/画像のD&D抑止
  window.addEventListener('click', (e) => {
    if (Date.now() - lpEndedAt < 400) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---- 無操作時のカーソル自動非表示を枠(iframe)内にも同期 ----
  // 親(multiview)の body.idle(cursor:none)はトップ文書にしか効かない。枠の上のカーソルは iframe 側の
  // 文書が管理するので、(a) 枠内の操作を tile-activity として親へ中継して「活動中」を伝え(枠の上で動かして
  // いる間はカーソル/≡ を消さない)、(b) 親からの set-idle を受けてこの文書のカーソルを消す/戻す。入れ子へも伝播。
  let idleStyleEl = null;
  const setFrameCursorHidden = (on) => {
    if (on) {
      if (!idleStyleEl) {
        idleStyleEl = document.createElement('style');
        idleStyleEl.textContent = '*, *::before, *::after { cursor: none !important; }';
      }
      if (!idleStyleEl.isConnected) (document.head || document.documentElement).appendChild(idleStyleEl);
    } else if (idleStyleEl && idleStyleEl.isConnected) {
      idleStyleEl.remove();
    }
  };
  let lastActivity = 0;
  const relayActivity = () => {
    setFrameCursorHidden(false); // ローカルでも即カーソルを戻す(往復待ちのチラつき防止)
    const now = Date.now();
    if (now - lastActivity < 400) return; // 中継は間引く(postMessage 連発を防ぐ)
    lastActivity = now;
    post('tile-activity');
  };
  window.addEventListener('pointermove', relayActivity, { capture: true, passive: true });
  window.addEventListener('pointerdown', relayActivity, { capture: true, passive: true });
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return; // この枠を埋め込んでいる親からのみ
    const d = e.data;
    if (!d || d[MAGIC] !== true || d.type !== 'set-idle') return;
    setFrameCursorHidden(d.value === true);
    for (const f of document.querySelectorAll('iframe')) { // 入れ子(YouTube live_chat 等)のカーソルも同期
      try { f.contentWindow.postMessage({ [MAGIC]: true, type: 'set-idle', value: d.value }, '*'); } catch (e2) { /* noop */ }
    }
  });

  // ---- 枠が今開いている URL を親(multiview)へ知らせる ----
  // 直下フレーム(枠本体)からのものだけ親=multiview に届く。枠内で別ページへ移動したら
  // 親が保存し直し、次回その URL を直接復元できる。読込時 + SPA(pushState 等)遷移時に通知。
  function reportUrl() {
    try {
      window.parent.postMessage({ [MAGIC]: true, type: 'frame-url', href: location.href }, '*');
    } catch (e) { /* noop */ }
  }
  reportUrl();
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', () => setTimeout(reportUrl, 0));
  }
  window.addEventListener('popstate', () => setTimeout(reportUrl, 0));
  window.addEventListener('hashchange', () => setTimeout(reportUrl, 0));

  // ---- Twitch のみ: シアターモードにして player を最大化(デスクトップ版サイト専用) ----
  // ※モバイル版にはこのボタンが無い(モバイルは上の枠内シアター 🎭 が担当)。
  // 注意: シアターは「トグル」。Twitch は前回のシアター状態を自前で記憶しているため、再読込時に
  // 既にシアターで開くことがある。そこを無条件に click すると "解除" してしまい、「一瞬シアター→
  // デフォルトに戻る」不具合になる。そこで『まだシアターでない時だけ』1回 click する。
  // 判定: シアター中はトグルボタンの aria-label が「終了 / Exit」系になる(=その時は触らない)。
  if (host.includes('twitch.tv')) {
    const BTN = '[data-a-target="player-theatre-mode-button"], button[aria-label*="シアター"], button[aria-label*="Theatre" i], button[aria-label*="Theater" i]';
    // 起動時に1回だけ: プレイヤーが現れたら、まだデフォルトの時だけシアターへ(既にシアターなら触らない)。
    // ※ SPA遷移ごとの再実行は、シアター切替→プレイヤー再生成→再navigate…のループを招き
    //    配信が激しくカクつくため行わない(ホーム経由のシアター化は別の安全な方法で対応する)。
    let tries = 0;
    const tTimer = setInterval(() => {
      if (tries++ >= 24) { clearInterval(tTimer); return; }
      const btn = document.querySelector(BTN);
      if (!btn) return; // プレイヤー(ボタン)がまだ無い → 次のポーリングへ
      const label = btn.getAttribute('aria-label') || '';
      if (/終了|exit|minimi/i.test(label)) { clearInterval(tTimer); return; } // 既にシアター → 触らない
      btn.click(); // まだデフォルト → シアターへ(1回だけ)
      clearInterval(tTimer);
    }, 500);
  }

  // ---- コメント弾幕: チャットDOMを監視して新着コメントを親(multiview)へ送る ----
  // 親からの set-danmaku-enabled で ON/OFF。ON の間だけ MutationObserver でチャットの新着行を拾い、
  // { type:'chat-message', text, author, color } を window.parent へ送る(描画は親=multiview)。
  // YouTube はチャットが入れ子 iframe(live_chat)にあるため、ON は子へ伝播し、コメントは子→親へ中継する。
  // セレクタはサイト更新で変わりうるので複数候補+防御的に(見つからなければ静かに何もしない)。
  const dmkSite =
    host.includes('twitch.tv') ? {
      // sel/containers はライブ + VOD(アーカイブ)両対応。.vod-message と .video-chat__message-list-wrapper が
      // VOD のチャットリプレイ用(twitch.tv/videos/...)。VOD は本文/絵文字/色の内側セレクタをライブと共用するので
      // extractParts/color は変更不要。ライブ用は VOD ページでマッチせず、その逆も同様なので併記で衝突しない。
      sel: '.chat-line__message, [data-a-target="chat-line-message"], .vod-message',
      containers: ['.chat-scrollable-area__message-container', '[data-test-selector="chat-scrollable-area__message-container"]', '.chat-list--default', '.video-chat__message-list-wrapper', '[data-test-selector="video-chat-message-list-wrapper"]'],
      // ライブの綺麗な表示名(.chat-author__display-name)を最優先。無い時だけ VOD 専用の著者ラッパへフォールバック。
      // ※ querySelector の複数指定は「文書順で最初」を返すため、ラッパが先に来ないよう || で順序を明示する。
      author: (n) => n.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]') || n.querySelector('.video-chat__message-author, [data-test-selector="comment-author-selector"]'),
      // 本文 = テキスト断片 + 絵文字/スタンプ(emote img)を出現順に parts 化。スタンプは画像として親へ渡す。
      // テキスト断片 + 行内の非バッジ img(絵文字/スタンプ/ビッツ)を出現順に。emote のクラス名変更にも強い。
      extractParts: (n) => {
        const parts = [];
        n.querySelectorAll('[data-a-target="chat-message-text"], img:not(.chat-badge)').forEach((p) => {
          if (p.tagName === 'IMG') parts.push({ img: p.currentSrc || p.src || '', alt: p.getAttribute('alt') || '' });
          else { const t = (p.textContent || '').replace(/\s+/g, ' '); if (t.trim()) parts.push({ text: t }); }
        });
        return parts;
      },
      color: (n) => { const a = n.querySelector('.chat-author__display-name'); return a ? a.style.color : ''; }
    } :
    host.includes('youtube.com') ? {
      sel: 'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer',
      containers: ['yt-live-chat-item-list-renderer #items', '#items.yt-live-chat-item-list-renderer'],
      author: (n) => n.querySelector('#author-name'),
      text: (n) => n.querySelector('#message'),
      color: () => ''
    } :
    (host.includes('mellow-fan.com') || host.includes('openrec.tv')) ? {
      // mellow-fan(旧 OPENREC)。改名後も URL 形式とチャットのコンテナ(.chat-list-content)は同じだが、
      // 行のクラスは .or-chat-article なので、旧 .chat-content では1件も拾えない(実機で確認)。
      sel: '.or-chat-article, [class*="ChatArticle__Wrapper"], .chat-content, [class*="chat-content"]',
      containers: ['.chat-list-content', '[class*="ChatList__Content"]', '.chat-list'],
      author: (n) => n.querySelector('[class*="user-name"], [class*="userName"]'),
      text: (n) => n.querySelector('[class*="message"], [class*="Message"], [class*="comment"]'),
      color: () => ''
    } : null;

  let dmkOn = false;
  let dmkObserver = null;
  let dmkContainer = null;
  let dmkSent = 0, dmkWindowStart = 0;
  const DMK_RATE = 40; // 1秒あたりの送信上限(高頻度チャットでの暴発抑制)

  // 要素内をテキスト/絵文字に分解して parts 配列で返す(出現順)。各要素は {text} か {img,alt}。
  // 絵文字/スタンプは画像として親へ渡す(親が <img> で描画)。Twitch のバッジ(chat-badge)は除外。
  function dmkPartsFromEl(el) {
    if (!el) return [];
    const parts = [];
    let buf = '';
    const flush = () => { const t = buf.replace(/\s+/g, ' '); if (t.trim()) parts.push({ text: t }); buf = ''; };
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) buf += c.nodeValue;                 // テキストノード
        else if (c.nodeType === 1) {
          if (c.tagName === 'IMG') {                              // 絵文字/スタンプ(バッジは除外)
            if (!c.classList.contains('chat-badge')) { flush(); parts.push({ img: c.currentSrc || c.src || '', alt: c.getAttribute('alt') || '' }); }
          } else walk(c);
        }
      }
    })(el);
    flush();
    return parts;
  }
  // parts を安全化: https の画像のみ・枚数/文字数/セグメント数の上限・空除去。
  function dmkCleanParts(parts) {
    const out = [];
    let textLen = 0, imgs = 0;
    for (const p of (parts || [])) {
      if (p && p.img) {
        if (imgs >= 24 || !/^https:\/\//i.test(String(p.img))) continue; // 絵文字画像は https のみ・最大24個
        out.push({ img: String(p.img).slice(0, 500), alt: String(p.alt || '').slice(0, 40) });
        imgs++;
      } else if (p && p.text != null) {
        let t = String(p.text);
        if (textLen + t.length > 200) t = t.slice(0, 200 - textLen);
        if (t) { out.push({ text: t }); textLen += t.length; }
      }
      if (out.length >= 60) break;
    }
    return out;
  }
  function dmkSend(line) {
    if (!dmkSite) return;
    try {
      const aEl = dmkSite.author(line);
      const author = aEl ? (aEl.textContent || '').trim().slice(0, 40) : '';
      let parts;
      if (dmkSite.extractParts) {
        parts = dmkSite.extractParts(line); // サイト専用(テキスト+絵文字画像。Twitch)
      } else {
        const textEl = dmkSite.text(line);
        parts = dmkPartsFromEl(textEl || line); // 専用本文要素を分解(YouTube #message 等。絵文字画像込み)
        if (!textEl && author && parts.length && parts[0].text) {
          // フォールバック(行全体を読んだ時): 先頭の著者名を取り除く
          const t = parts[0].text.replace(/^\s+/, '');
          if (t.startsWith(author)) parts[0].text = t.slice(author.length);
        }
      }
      parts = dmkCleanParts(parts);
      if (!parts.length) return;
      let color = '';
      try { color = dmkSite.color(line) || ''; } catch (e) { /* noop */ }
      const now = Date.now();
      if (now - dmkWindowStart > 1000) { dmkWindowStart = now; dmkSent = 0; }
      if (dmkSent >= DMK_RATE) return; // 一気に大量に来たら間引く
      dmkSent++;
      window.parent.postMessage({ [MAGIC]: true, type: 'chat-message', parts, author, color, ts: now }, '*');
    } catch (e) { /* noop */ }
  }
  function dmkProcessNode(node) {
    if (!dmkSite || !node || node.nodeType !== 1) return;
    if (node.matches && node.matches(dmkSite.sel)) dmkSend(node);
    else if (node.querySelectorAll) node.querySelectorAll(dmkSite.sel).forEach(dmkSend);
  }
  function dmkAttach(container) {
    if (dmkObserver) dmkObserver.disconnect();
    dmkObserver = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) dmkProcessNode(n);
    });
    // subtree:true は VOD(アーカイブ)対応で必須。VOD のチャットリプレイは新着行を wrapper 直下ではなく
    // ネストした <ul> に追加する(間に <div> が挟まることもある)ため、childList だけだと取りこぼす。
    // dmkProcessNode は sel に一致するノードだけ送るので、内部の遅延ロード(絵文字 img 等)で多重送信はしない。
    dmkObserver.observe(container, { childList: true, subtree: true });
  }
  // 入れ子チャット(現状 YouTube の live_chat)を持つ子 iframe にだけ ON/OFF を伝える。広告/第三者 iframe には
  // 送らず、targetOrigin も YouTube に固定。ON 中は dmkTick から毎周期呼び、遅延ロードの live_chat も取りこぼさない。
  function dmkBroadcastChildren() {
    if (!host.includes('youtube.com')) return; // 入れ子チャットを持つのは現状 YouTube のみ
    const frames = document.querySelectorAll('iframe#chatframe, iframe[src*="/live_chat"]');
    for (const f of frames) {
      try { f.contentWindow.postMessage({ [MAGIC]: true, type: 'set-danmaku-enabled', value: dmkOn }, 'https://www.youtube.com'); } catch (e) { /* noop */ }
    }
  }
  // チャット欄が見つかっているかを親へ知らせる。サイトの DOM が変わってセレクタが古くなると
  // 弾幕は「ONにしたのに何も流れない」状態になるが、それが故障なのかチャットが過疎なだけなのかを
  // 利用者もコードも区別できなかった。見つからない状態が続いたら報告して枠バッジに出す。
  let dmkReported = null;
  let dmkMissTicks = 0;
  const DMK_MISS_LIMIT = 7; // 1.5秒 × 7 ≒ 10秒。読み込みの遅れでは鳴らないだけの余裕を取る
  function reportDanmaku(state) {
    if (dmkReported === state) return;
    dmkReported = state;
    try {
      window.parent.postMessage({ [MAGIC]: true, type: 'danmaku-state', state }, '*');
    } catch (e) { /* noop */ }
  }

  function dmkTick() {
    if (!dmkSite) return;
    if (!dmkOn) {
      if (dmkObserver) { dmkObserver.disconnect(); dmkObserver = null; }
      dmkContainer = null;
      dmkMissTicks = 0;
      reportDanmaku('off');
      return;
    }
    dmkBroadcastChildren(); // ON中は毎周期、遅れて出てくる live_chat 子へも value:true を送り直す(取りこぼし対策)
    if (dmkContainer && dmkContainer.isConnected) { dmkMissTicks = 0; reportDanmaku('on'); return; } // 監視中
    for (const sel of dmkSite.containers) {
      const c = document.querySelector(sel);
      if (c) { dmkContainer = c; dmkAttach(c); break; } // SPA再生成にもこのポーリングで張り直す
    }
    if (dmkContainer) { dmkMissTicks = 0; reportDanmaku('on'); }
    else if (++dmkMissTicks >= DMK_MISS_LIMIT) reportDanmaku('missing');
  }
  // 親から呼ばれる(set-danmaku-enabled)。自分の監視を ON/OFF し、入れ子チャットの子へも伝播する。
  function danmakuSetEnabled(on) {
    dmkOn = !!on;
    dmkTick();
    dmkBroadcastChildren(); // OFF も即時伝播(dmkTick は OFF だと早期 return するため)
  }
  if (dmkSite) setInterval(dmkTick, 1500);

  // 入れ子フレーム連携: 子からの chat-message は親へ中継し、子の frame-hello には現在の弾幕状態を返す
  // (子の読込が遅れても取りこぼさない)。親からの下り(set-*)は上の本体リスナが処理する。
  // 中継を許可するのは対象サイト配下のフレームのみ(YouTube live_chat 等)。第三者/広告 iframe からの偽装を弾く。
  const DMK_RELAY_HOSTS = ['twitch.tv', 'youtube.com', 'openrec.tv', 'mellow-fan.com'];
  function dmkOriginAllowed(origin) {
    try { const h = new URL(origin).hostname; return DMK_RELAY_HOSTS.some((d) => h === d || h.endsWith('.' + d)); }
    catch (e) { return false; }
  }
  window.addEventListener('message', (e) => {
    if (e.source === window.parent) return;   // 子フレームからのメッセージだけ扱う
    if (!dmkOriginAllowed(e.origin)) return;  // 対象サイト配下の子のみ(広告/第三者iframeを弾く)
    const d = e.data;
    if (!d || d[MAGIC] !== true) return;
    if (d.type === 'tile-activity') { // 入れ子(live_chat 等)の操作も上(最終的にトップ)へ「活動中」として中継
      try { window.parent.postMessage(d, '*'); } catch (err) { /* noop */ }
    } else if (d.type === 'chat-message') {
      if (!dmkOn) return; // ON の間だけ中継(不要中継・注入面の縮小)
      try { window.parent.postMessage(d, '*'); } catch (err) { /* noop */ }
    } else if (d.type === 'frame-hello') {
      try { e.source.postMessage({ [MAGIC]: true, type: 'set-danmaku-enabled', value: dmkOn }, e.origin || '*'); } catch (err) { /* noop */ }
    }
  });
})();
