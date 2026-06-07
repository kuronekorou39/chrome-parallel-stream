// MAIN world(YouTube の JS コンテキスト)で動く、広告スキップの「実行役」。
// 別プロジェクト(chrome-ad-skipper)の YouTube 広告スキップ技術をこのプロジェクトへ移植したもの。
//
// 検知は ISOLATED world の stream-control.js が担当し、#movie_player の ad-showing を見つけると
// postMessage で 'skip-ad' / 'resume-playback' を依頼してくる。ここでは YouTube 内部の player API
// (skipAd 等)や広告 video のシークで実際に広告を飛ばす。これらの内部APIは MAIN world でしか
// 触れないため、検知(ISOLATED)と実行(MAIN)を分けている。
//
// multiview の iframe 内でだけ動かす(通常タブには干渉しない)。

(function ytAdSkipMain() {
  if (window.top === window.self) return; // multiview のタイル(iframe)内のみで動作
  const AD_SKIP_SOURCE = 'mvAdSkip'; // stream-control.js 側と一致させること

  window.addEventListener('message', (event) => {
    if (event.source !== window) return; // 同一 window 内のやり取りだけ受ける
    const d = event.data;
    if (!d || d.source !== AD_SKIP_SOURCE) return;
    if (d.type === 'skip-ad') skipAd();
    else if (d.type === 'resume-playback') resumePlayback();
  });

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  // 広告を飛ばす。内部API → player のシーク → video のシーク、の順に効くものを使う。
  function skipAd() {
    const player = getPlayer();
    if (player) {
      // Method 1: 既知の内部 player API(未公開・将来変わりうるので複数試す)
      for (const m of ['skipAd', 'cancelPlayback', 'finishAd', 'exitAd']) {
        if (typeof player[m] === 'function') {
          try { player[m](); return; } catch (e) { /* 次の手段へ */ }
        }
      }
      // Method 2: player API で広告の最後までシーク
      if (typeof player.getDuration === 'function' && typeof player.seekTo === 'function') {
        const dur = player.getDuration();
        if (dur && isFinite(dur)) { player.seekTo(dur - 0.1, true); return; }
      }
    }
    // Method 3: <video> を直接末尾までシーク(ISOLATED でも可能な最終手段)
    const video = document.querySelector('video');
    if (video && video.duration && isFinite(video.duration) && !video.paused) {
      video.currentTime = video.duration;
    }
  }

  // 広告スキップ後、シークの影響で本編が一時停止/終了状態のままになることがあるので再生に戻す。
  function resumePlayback() {
    const player = getPlayer();
    if (player && typeof player.playVideo === 'function') { player.playVideo(); return; }
    const video = document.querySelector('video');
    if (video && video.paused) video.play().catch(() => {});
  }
})();
