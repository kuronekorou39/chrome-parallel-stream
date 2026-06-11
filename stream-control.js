// 配信サイトが iframe 内(= multiview のタイル)で読まれたときに動く content script。
// 役割:
//   1. 起動直後だけフレーム内の <video> を全ミュート(轟音防止)。以後は干渉せず、
//      ユーザーが各配信プレイヤー自前のミュート/音量で操作できるようにする。
//   2. 親(multiview)からの「音量設定」指示で全 <video> の音量を設定(マスタ音量つまみ用)。
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
  // muted は触らない(各プレイヤー自前のミュートで「1つだけ聞く」が可能)。
  let mvVolume = null; // null = まだ未受信
  function applyVol() {
    if (mvVolume === null) return;
    document.querySelectorAll('video').forEach((v) => {
      if (Math.abs(v.volume - mvVolume) > 0.005) {
        try { v.volume = mvVolume; } catch (err) { /* noop */ }
      }
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return; // 親以外からの偽装を弾く
    const d = e.data;
    if (!d || d[MAGIC] !== true || d.type !== 'set-volume') return;
    mvVolume = Math.max(0, Math.min(1, Number(d.value)));
    applyVol();
  });

  // プレイヤーの上書きや、遅延ロード/SPA遷移で現れた新しい video にも、親の指定値を当て続ける。
  // (枠ごと音量は 🎨 パネルで操作する設計なので、これで取り違え・戻し問題は起きない)
  setInterval(applyVol, 1000);

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
