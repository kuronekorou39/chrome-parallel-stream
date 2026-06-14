// 配信サイトが iframe 内(= multiview のタイル)で読まれたときに動く content script。
// 役割:
//   1. 起動直後だけフレーム内の <video> を全ミュート(轟音防止)。
//   2. 親(multiview)からの「音量設定」指示で全 <video> の volume と muted を維持する
//      (音はスライダーが所有。スマホ縦積みではプレイヤーUIに触れないため、これが唯一の音導線)。
//   3. Twitch のみ: シアターモードを1回 click して player を最大化。
// 最上位タブ(通常閲覧)では何もしない。

(function streamControl() {
  if (window.top === window.self) return; // iframe 内のみ動作
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
  const post = (type, extra) => {
    try {
      window.parent.postMessage(Object.assign({ [MAGIC]: true, type }, extra || {}), '*');
    } catch (e) { /* noop */ }
  };
  window.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.shiftKey) { // Shift+クリック = 親へ「この枠を複数選択にトグル」(サイトには通さない)
      try { e.preventDefault(); } catch (_) { /* noop */ }
      post('tile-shift-click');
      return; // 長押し検知は始めない
    }
    lpDown = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY };
    lpDragging = false;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (!lpDown) return;
      lpDragging = true;
      post('tile-drag-start', lpDown);
    }, LP_MS);
  }, true); // capture: サイト側が stopPropagation しても拾う
  window.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
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
    if (lpDragging) {
      lpDragging = false;
      lpEndedAt = Date.now();
      post('tile-drag-end');
    }
  };
  window.addEventListener('pointerup', lpEnd, true);
  window.addEventListener('pointercancel', lpEnd, true);
  // ドラッグ中はサイト側のスクロール・テキスト選択・長押しメニューを抑止し、離した直後の click も無効化。
  window.addEventListener('touchmove', (e) => {
    if (lpDragging && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  // 長押し待ち中(lpDown)から抑止する。成立(lpDragging)を待つと、待つ間のわずかな移動で先に
  // 選択や選択メニューが始まってしまい、ドラッグ移動後も選択が残る。押している間は選択/メニュー/D&Dを止める。
  window.addEventListener('contextmenu', (e) => { if (lpDragging || lpDown) e.preventDefault(); }, true);
  window.addEventListener('selectstart', (e) => { if (lpDragging || lpDown) e.preventDefault(); }, true);
  window.addEventListener('dragstart', (e) => { if (lpDragging || lpDown) e.preventDefault(); }, true); // リンク/画像のD&D抑止
  window.addEventListener('click', (e) => {
    if (Date.now() - lpEndedAt < 400) { e.preventDefault(); e.stopPropagation(); }
  }, true);

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

  // ---- Twitch のみ: シアターモードを1回 click して player を最大化 ----
  // ※デスクトップ版サイト専用(モバイル版にはこのボタンが無い)。モバイルは上の枠内シアター(🎭)で。
  if (host.includes('twitch.tv')) {
    const SELECTORS = [
      '[data-a-target="player-theatre-mode-button"]',
      'button[aria-label*="シアター"]',
      'button[aria-label*="Theatre" i]',
      'button[aria-label*="Theater" i]'
    ];
    let tries = 0;
    const tTimer = setInterval(() => {
      if (tries++ >= 20) { clearInterval(tTimer); return; }
      for (const sel of SELECTORS) {
        const el = document.querySelector(sel);
        if (el) { el.click(); clearInterval(tTimer); return; }
      }
    }, 500);
  }

  // ---- YouTube のみ: 広告を自動スキップ ----
  // 別プロジェクト(chrome-ad-skipper)の YouTube 広告スキップ技術をこのプロジェクトへ移植したもの。
  // 検知(#movie_player の ad-showing クラス)はこの content script(ISOLATED world)で行い、実際の
  // スキップ(player.skipAd() 等の内部API / 広告 video のシーク)は YouTube の JS コンテキストでしか
  // 触れないので、MAIN world の yt-ad-skip-main.js へ postMessage で依頼する。ボタンで飛ばせる
  // スキップ可能広告は、この ISOLATED 側でも直接 click しておく(内部APIが変わったときの保険)。
  if (host.includes('youtube.com')) {
    const AD_SKIP_SOURCE = 'mvAdSkip'; // yt-ad-skip-main.js 側と一致させること
    const AD_SKIP_KEY = 'adSkipEnabled'; // multiview ツールバーのトグルが書き込む storage キー
    const PLAYER_SELECTOR = '#movie_player';
    const POLL_INTERVAL = 300;        // ad-showing の監視間隔
    const SKIP_RETRY_INTERVAL = 1500; // 同一広告中にスキップを再試行する間隔
    const SKIP_BUTTON_SELECTORS = [
      '.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button',
      '.ytp-skip-ad-button',
      '.ytp-ad-overlay-close-button' // 動画下部のオーバーレイ広告を閉じる
    ];
    let adSkipEnabled = false; // デフォルト OFF。ユーザーがツールバーのトグルで ON にするまで何もしない。
    let adPlaying = false;
    let lastSkipAttempt = 0;

    // 広告検知の状態を親(multiview)へ通知 → その枠に「広告スキップ中」表示を出す/消す。
    const notifyAdState = (on) => {
      try {
        window.parent.postMessage({ [MAGIC]: true, type: 'ad-state', adSkipping: on }, '*');
      } catch (e) { /* noop */ }
    };

    // オン/オフは multiview ツールバーのトグルが storage に書き込む。起動時に現在値を読み、
    // 以後は storage.onChanged で追従する(枠を開いたままトグルしても即反映される)。
    try {
      chrome.storage.local.get(AD_SKIP_KEY, (d) => { adSkipEnabled = d[AD_SKIP_KEY] === true; });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[AD_SKIP_KEY]) {
          adSkipEnabled = changes[AD_SKIP_KEY].newValue === true;
          if (!adSkipEnabled) { adPlaying = false; notifyAdState(false); } // OFF にしたら検知状態もリセット
        }
      });
    } catch (e) { /* noop */ }

    const clickSkipButtons = () => {
      for (const sel of SKIP_BUTTON_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn) { try { btn.click(); } catch (e) { /* noop */ } }
      }
    };

    const checkAd = () => {
      if (!adSkipEnabled) return; // OFF のときは検知もスキップ依頼もしない(MAIN world も黙ったまま)
      const player = document.querySelector(PLAYER_SELECTOR);
      if (!player) return;
      if (player.classList.contains('ad-showing')) {
        if (!adPlaying) { adPlaying = true; lastSkipAttempt = 0; notifyAdState(true); }
        const now = Date.now();
        if (now - lastSkipAttempt > SKIP_RETRY_INTERVAL) {
          lastSkipAttempt = now;
          clickSkipButtons();
          window.postMessage({ source: AD_SKIP_SOURCE, type: 'skip-ad' }, '*');
        }
      } else if (adPlaying) {
        adPlaying = false;
        notifyAdState(false);
        setTimeout(() => window.postMessage({ source: AD_SKIP_SOURCE, type: 'resume-playback' }, '*'), 300);
      }
    };

    // class 変化に即応(MutationObserver)しつつ、取りこぼし用にポーリングも回す。
    (function observePlayer() {
      const player = document.querySelector(PLAYER_SELECTOR);
      if (!player) { setTimeout(observePlayer, 1000); return; }
      new MutationObserver(checkAd).observe(player, { attributes: true, attributeFilter: ['class'] });
    })();
    setInterval(checkAd, POLL_INTERVAL);
  }
})();
