// 枠の中身(iframe・チャット)の読み込みと、枠からのメッセージ。

// content script(stream-control.js)から「この枠が今開いている URL」を受け取り、
// 枠内で別の配信ページへ移動したら、その URL を保存して次回復元できるようにする。
function onFrameUrl(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true || d.type !== 'frame-url' || !d.href) return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win || win.url === d.href) return;
  if (win.light) return; // 軽量プレイヤー表示中はその URL で元ページ(win.url)を上書きしない
  win.url = d.href;
  pushWinHistory(win, d.href); // ⋮メニューの「戻る」用
  updateWinTitle(win);
  saveLineup();
  renderMixer(); // 一覧のラベルも更新
  // 枠の中で一覧から配信・動画を選んだら、その時点で「プレイヤー + チャット」の構成へ移る。
  // 利用者に軽量/通常を選ばせない方針(見ている対象で決まる話でしかない)。
  // YouTube は視聴ページを枠に入れるとレンダラが落ちるので、そもそも他に選択肢が無い。
  if (toLightUrl(win.url)) switchToEmbed(win);
}

// live_chat 枠からの「チャットが使えるか」。使えない動画(ライブでない等)では列ごと畳む。
// 中身は別オリジンで覗けないので、枠の中の content script が判定して送ってくる。
// 出したあとで枠の中が「チャットは無効」だった場合の保険。出す判断は先の問い合わせで
// 済んでいるので、ここは畳む方向にしか働かせない(出し直すと画面がガタつく)。
function onChatAvailability(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true || d.type !== 'chat-availability' || d.ok) return;
  const win = wins.find((w) => w.chatFrame && w.chatFrame.contentWindow === e.source);
  if (win) hideChat(win, 'なし');
}

// チャット再生は親から再生位置をもらって進む。位置は YouTube の埋め込み API から直接受け取る
// (content script を挟むと拡張の再読み込みが要るうえ、部品が増えて壊れやすい)。
// 埋め込み枠へ listening を送ると、以後 infoDelivery で currentTime が流れてくる。
function startPlayerTimeFeed(win) {
  if (!win.frame) return;
  try {
    win.frame.contentWindow.postMessage(
      JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
      'https://www.youtube.com'
    );
  } catch (e) { /* noop */ }
}

function onPlayerInfo(e) {
  if (typeof e.data !== 'string' || e.data.indexOf('infoDelivery') === -1) return;
  let d;
  try {
    d = JSON.parse(e.data);
  } catch (err) {
    return;
  }
  const t = d && d.info && d.info.currentTime;
  if (typeof t !== 'number') return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win || !win.chatReplay || !win.chatFrame) return;
  try {
    win.chatFrame.contentWindow.postMessage({ 'yt-player-video-progress': t }, 'https://www.youtube.com');
  } catch (err) { /* noop */ }
}

// ====== 枠の中の「戻る」 ======
// iframe の履歴は別オリジンだと親から操作できない(contentWindow.history は覗けない)。
// また YouTube は動画ページで埋め込みへ切り替えるので、そもそも枠の履歴とはずれる。
// そこで枠が辿った URL を自前で覚え、1つ前へ戻す。
const WIN_HISTORY_MAX = 20;

function pushWinHistory(win, url) {
  if (!url) return;
  if (!win.history) win.history = [];
  if (win.history[win.history.length - 1] === url) return;
  win.history.push(url);
  if (win.history.length > WIN_HISTORY_MAX) win.history.shift();
  syncMenuLabels(win); // 「戻る」の押せる/押せないを更新(メニュー生成前は何もしない)
}

function canGoBack(win) {
  return !!(win.history && win.history.length > 1);
}

// 1つ前のページへ戻す。戻り先が埋め込みに変換できるページ(YouTubeの動画・Twitchのチャンネル)
// なら埋め込み構成、そうでなければ(一覧・トップ)サイト全体で開く。
function goBackWindow(win) {
  if (!canGoBack(win)) return;
  win.history.pop();
  const prev = win.history[win.history.length - 1];
  win.url = prev;
  win.light = !!toLightUrl(prev);
  win.tall = null;
  updateWinTitle(win);
  syncMenuLabels(win);
  remountFrame(win);
  relayoutStack();
  saveLineup();
  renderMixer();
}

// 枠を埋め込み構成(映像=embed / チャット=live_chat)へ切り替える。既にそうなら何もしない。
function switchToEmbed(win) {
  if (win.light || !toLightUrl(win.url)) return;
  win.light = true;
  win.tall = null;
  updateWinTitle(win);
  syncMenuLabels(win);
  remountFrame(win);
  relayoutStack();
  saveLineup();
  renderMixer();
}

// content script(stream-control.js)からの状態通知。
//  - theater-state: 枠内シアター発動中 → バッジに 🎭 を出す(効いているかの確認用)。
function onFrameState(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true) return;
  const win = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
  if (!win) return;
  if (d.type === 'adblock-state') {
    // 枠内に広告ブロッカー(別拡張の vaft)が入っているかの診断。バッジに 🛡/🚫 で出す。
    win.adblock = d.state || null;
    win.vaft = win.adblock ? win.adblock.vaft : null;
    updateWinTitle(win);
  } else if (d.type === 'danmaku-state') {
    // 'on'=チャット欄を監視中 / 'missing'=ONなのに見つからない(サイトのDOM変更の疑い) / 'off'
    win.danmakuState = d.state;
    updateWinTitle(win);
  } else if (d.type === 'theater-state') {
    win.theaterState = d.state; // 'on' | 'searching' | 'off'
    updateWinTitle(win); // バッジの 🎭/🔎 表示を更新
  } else if (d.type === 'delay-state') {
    // 枠の中で実際に付いている遅延(twitch-keepalive.js から)。調整パネルの表示に使う。
    win.delayState = d.state || null;
    if (win.syncDelayUI) win.syncDelayUI();
  } else if (d.type === 'stream-state') {
    onStreamState(win, d.state);
  } else if (d.type === 'sync-audio') {
    onSyncAudio(win, d);
  } else if (d.type === 'play-diag') {
    onPlayDiag(win, d);
  } else if (d.type === 'frame-hello') {
    hidePlayDiag(win); // 枠の中で別のページへ移った(再読込を含む)。前のページの診断は古い
    syncFrameTheater(win);  // 起動した frame に現在のシアター設定を返す(読込すれ違い対策)
    syncFrameDanmaku(win);  // 同じく現在の弾幕 ON/OFF も返す
    // 音量も返す。frame の load を待っていると、その前にプレイヤーが記憶値(たいてい最大)で
    // 鳴り始めることがある。挨拶=content script 注入直後に渡せば、たいていは <video> が
    // できる前に音量が決まり、最初の一音から正しい大きさで出せる。
    applyVolume(win, masterVolume);
    syncFrameDelay(win); // 再読込した枠にも、指定してあった遅延を付け直す
  }
}

// ====== Twitch の映像が始まらないときの診断 ======
// スマホで、チャットは取れているのに映像だけ出ないことが時々ある。原因を切り分けるため、
// 枠の中(stream-control.js)が「読み込んでもしばらく再生が始まらない」と知らせてきたら、
// そのときのプレイヤーの状態を枠の上に出す(画面を撮って送ってもらえるように)。
function onPlayDiag(win, d) {
  if (!d.stuck) {
    hidePlayDiag(win);
    win.playStartSec = d.startSec; // 遅れて始まったときの参考
    return;
  }
  if (!win.body) return;
  const i = d.info || {};
  const m = i.main;
  const r = i.res;
  const yn = (v) => (v ? 'あり' : 'なし');
  const lines = [
    '経過 ' + i.elapsed + '秒 / video ' + i.videos + '個 / 表示 ' + i.vis,
    i.videos
      ? '停止中 ' + (i.paused ? 'はい' : 'いいえ') + ' / ready ' + i.ready + ' / network ' + i.network +
        ' / 位置 ' + i.time + 's / 先読み ' + i.buffered + 's / ミュート ' + (i.muted ? 'はい' : 'いいえ') +
        ' / src ' + (i.src || 'なし')
      : '',
    i.error ? 'エラー ' + i.error : '',
    i.button ? '再生ボタン ' + i.button : '',
    i.mature ? '年齢確認が出ています' : '',
    // ここから下は原因の切り分け用(古い拡張機能は送ってこないので、あるものだけ出す)。
    m ? '差し替え Worker ' + yn(m.workerHooked) + ' / fetch ' + yn(m.fetchHooked) +
        ' / MSE ' + yn(m.mse) + ' / MMS ' + yn(m.mms) : '',
    '広告ブロッカーの通知 ' + (win.adblock ? JSON.stringify(win.adblock).slice(0, 80) : 'なし'),
    r ? '通信 全' + r.total + ' / gql ' + r.gql + ' / worker ' + r.worker + ' / wasm ' + r.wasm +
        ' / 配信 ' + r.media + (r.failed && r.failed.length ? ' / 失敗 ' + r.failed.join(', ') : '') : '',
    i.net ? '回線 ' + i.net : '',
    m ? 'video のイベント ' + (m.events || 'なし') : '',
    m && m.errors ? 'スクリプトのエラー ' + m.errors + '件 最後「' + m.lastError + '」' : '',
    i.overlay ? '表示 「' + i.overlay + '」' : ''
  ].filter(Boolean);
  let el = win.playDiagEl;
  if (!el) {
    el = document.createElement('div');
    el.className = 'win-diag';
    const head = document.createElement('div');
    head.className = 'win-diag-head';
    const title = document.createElement('span');
    title.textContent = '映像が始まりません(診断)';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = '再読込';
    reload.addEventListener('click', () => { hidePlayDiag(win); reloadWindow(win); });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'この表示を閉じる';
    close.addEventListener('click', () => hidePlayDiag(win));
    head.append(title, reload, close);
    const body = document.createElement('div');
    body.className = 'win-diag-body';
    el.append(head, body);
    win.body.appendChild(el);
    win.playDiagEl = el;
  }
  el.querySelector('.win-diag-body').textContent = lines.join('\n');
  console.info('[multiview] 映像が始まらない枠:', win.url, i);
}

function hidePlayDiag(win) {
  if (win.playDiagEl) { win.playDiagEl.remove(); win.playDiagEl = null; }
}

// ====== 終わった配信を自動で隠す ======
// この枠で配信が流れるのを一度見てから終わったときだけ隠す。オフラインのチャンネルを追加した直後に
// 枠が消えると、追加に失敗したように見えるため。再開したら自動で出す。
// 手で出し直した枠は、次に配信が始まるまで隠さない。
function onStreamState(win, state) {
  win.streamState = state;
  clearTimeout(win.streamEndTimer);
  if (state === 'live') {
    win.streamSeenLive = true;
    win.stayVisible = false;
    if (win.autoHidden) {
      win.autoHidden = false;
      showWindow(win);
    }
  } else if (state === 'offline') {
    armStreamEndHide(win);
  }
}

function armStreamEndHide(win) {
  clearTimeout(win.streamEndTimer);
  // スマホには切り替えの場所(配置ポップアップ)が無いので、自動では隠さない。
  if (!autoHideEnded || stackMode || !win.streamSeenLive || win.stayVisible || win.hidden) return;
  win.streamEndTimer = setTimeout(() => {
    if (!wins.includes(win) || win.hidden || win.stayVisible || !autoHideEnded || stackMode) return;
    if (win.streamState !== 'offline') return;
    win.autoHidden = true; // hideWindow の保存より先に立てる(更新後は隠さず出すため)
    hideWindow(win);
  }, STREAM_END_HIDE_MS);
}

function setAutoHideEnded(on) {
  autoHideEnded = on;
  try { MV.storage.local.set({ [AUTO_HIDE_ENDED_KEY]: on }); } catch (e) { /* noop */ }
  wins.forEach((win) => {
    if (on) {
      if (win.streamState === 'offline') armStreamEndHide(win);
      return;
    }
    clearTimeout(win.streamEndTimer);
    if (win.autoHidden) {
      win.autoHidden = false;
      showWindow(win);
    }
  });
}

// ====== 位置・サイズ ======

// 枠の中の content script へ送る。読み込み前や閉じた枠でも落ちないようにする。
function postToFrame(frame, msg) {
  if (!frame) return;
  try {
    frame.contentWindow.postMessage({ [MAGIC]: true, ...msg }, '*');
  } catch (e) { /* noop */ }
}

function loadFrameWithLogin(frameEl, domain, src) {
  if (!cookieRelaxOn) { frameEl.src = src; return; } // OFF なら Cookie に触れない(未ログイン表示になる)
  MV.runtime
    .sendMessage({ type: 'relax-cookies', domains: [domain] })
    .then(() => { frameEl.src = src; })
    .catch(() => { frameEl.src = src; }); // 失敗しても一応読み込む
}

// 埋め込み内でログインを使いたいサイトの cookie 緩和対象ドメインを返す(対象外は null)。
// YouTube は埋め込みログインの仕組みが別で、緩和がむしろ逆効果になりうるため対象にしない。
function loginDomainOf(host) {
  const site = SITES[siteKeyOf(host)];
  if (!site || !site.login) return null;
  return site.hosts.find((d) => hostMatches(host, d));
}

// Kick 枠のチャット表示/非表示を切り替える。
// チャット列に中身があるか。通常表示(サイト全体)はサイト自身がチャットを持つのでこちらは使わず、
// チャットの無い動画では読み込んでもいない。どちらの場合も開いても真っ黒な列が出るだけなので、
// 開けないようにする(押しても意味のない操作を残さない)。
function hasChatContent(win) {
  if (!win.chatFrame) return false;
  return !!win.light && !win.chatUnavailable && !win.chatPending;
}

function toggleChat(win) {
  if (!win.body || !hasChatContent(win)) return;
  win.chatOn = !win.chatOn;
  syncChatVisibility(win);
  saveLineup(); // 枠ごとの選択は保存する(全体の既定は ≡ メニュー側が持つ)
}

// チャット列の見せ方を決めて当てる。3つの状態がある:
//   出す  (chat-on)   … この枠でチャットを出す設定 かつ 中身があり かつ 枠に置ける大きさがある
//   生かす(chat-feed) … 出さないが弾幕が ON。チャットは弾幕の取得元なので、消さずに実寸のまま
//                        切り落として残す(display:none にするとサイトがコメントを描かなくなる)
//   止める(どちらも無し)… 描かせない。読み込み自体はしてあるので、いつでも出せる
// Kick も同じ扱い(入れ物 + iframe の構造に揃えてあるので切り落としが効く)。
function syncChatVisibility(win) {
  if (!win.body) return;
  const usable = hasChatContent(win);
  const show = usable && !!win.chatOn && !win.el.classList.contains('cq-hide-chat');
  const feed = usable && !show && !!win.danmaku.on;
  win.body.classList.toggle('chat-on', show);
  win.body.classList.toggle('chat-feed', feed);
  // 枠側にも出しておく。リサイズのつまみは枠の直下にあり、チャットが右に出ている間は
  // その幅ぶん内側へ寄せる必要があるが、chat-on は .win-body 側なので選べない。
  // 縦か横かを決める chat-below も枠側にあるので、両方が枠に載っていれば CSS だけで決まる。
  win.el.classList.toggle('chat-visible', show);
  if (win.chatBtn) {
    win.chatBtn.classList.toggle('active', show);
    win.chatBtn.disabled = !usable;
  }
  syncMenuLabels(win);
  if (stackMode) relayoutStack(); // チャット分のタイル高が変わる
}

// 全枠のチャットをまとめて出す/畳む。次に追加される枠の既定にもなる(≡メニューから)。
function setAllChat(on) {
  chatDefaultOn = on;
  wins.forEach((w) => { w.chatOn = on; syncChatVisibility(w); });
  syncMainMenuToggles();
  saveLineup();
}

// サイト枠(Twitch/YouTube/OPENREC)の iframe を生成して body に載せる。
// 軽量モード(win.light)の枠は、フルサイトではなく公式埋め込みプレイヤーだけを読み込む。
function mountSiteFrame(win) {
  // 読み直すと別の配信になりうるので、終了の判定はやり直す。
  clearTimeout(win.streamEndTimer);
  hidePlayDiag(win);
  win.streamState = null;
  win.streamSeenLive = false;
  win.stayVisible = false;
  const frame = document.createElement('iframe');
  frame.allow = IFRAME_ALLOW;
  // チャットと2分割する枠では、映像は .win-media の中へ入れる(iframe は絶対配置なので
  // body 直下に置くと flex の並びから外れてチャットと重なる)。
  (win.mediaEl || win.body).appendChild(frame);
  win.frame = frame;
  mountChatFrame(win);
  applyFrameZoom(win); // 縮小表示(🔍)の倍率を反映
  frame.addEventListener('load', () => {
    startPlayerTimeFeed(win); // 埋め込みプレイヤーなら再生位置が流れてくるようになる
    applyVolume(win, masterVolume);
    syncFrameTheater(win);  // シアター有効化(+全画面中なら一時停止)を伝える
    syncFrameDanmaku(win);  // 弾幕 ON 中なら再読込後も監視を再開させる
    syncFrameDelay(win);    // 遅延を指定してあれば付け直す
    hideWinLoading(win); // 読み込み中スピナーを消す(出ていれば)
  });
  const src = (win.light && toLightUrl(win.url)) || win.url;
  // ログインCookieを埋め込みへ通す(SameSite緩和)。対象サイトのみ(src 基準で判定)。
  const loginDomain = loginDomainOf(hostOf(src));
  if (loginDomain) {
    loadFrameWithLogin(frame, loginDomain, src);
  } else {
    frame.src = src;
  }
  applyVolume(win, masterVolume);
}

// YouTube の枠に並べる公式チャット(live_chat)を今の URL に合わせて読み込む。
// 通常表示(視聴ページ)のときはページ自身がチャットを持つので、こちらの枠は畳んでおく。
// チャットは「あると分かってから」出す。先に出して畳むと画面がガタつくので、
// 読み込む前に service worker へ問い合わせ、ライブ / 過去のライブ / 無し を確定させる。
function mountChatFrame(win) {
  const chat = win.chatFrame;
  if (!chat) return;
  if (!win.light) {
    // 通常表示(サイト全体)はページ自身がチャットを持つので、こちらの列は使わない。
    chat.src = 'about:blank';
    win.chatKey = null; // 次に軽量へ戻したら読み直せるようにする
    hideChat(win, 'なし');
    return;
  }
  // Twitch は全チャンネルにチャットがあるので、有無の問い合わせは要らない。
  const twitchUrl = toTwitchChatUrl(win.url);
  if (twitchUrl) {
    if (win.chatKey === twitchUrl) return;
    win.chatKey = twitchUrl;
    win.chatReplay = false;
    chat.addEventListener('load', () => syncFrameDanmaku(win), { once: true });
    loadFrameWithLogin(chat, 'twitch.tv', twitchUrl); // 書き込めるようログインCookieを通す
    showChat(win);
    return;
  }
  const kickChannel = kickWatchChannel(win.url);
  if (kickChannel) {
    const kickUrl = 'https://kick.com/popout/' + encodeURIComponent(kickChannel) + '/chat';
    if (win.chatKey === kickUrl) return;
    win.chatKey = kickUrl;
    win.chatReplay = false;
    chat.addEventListener('load', () => syncFrameDanmaku(win), { once: true });
    loadFrameWithLogin(chat, 'kick.com', kickUrl);
    showChat(win);
    return;
  }
  const id = youtubeVideoIdOf(win.url);
  if (!id) {
    chat.src = 'about:blank';
    win.chatKey = null;
    hideChat(win, 'なし');
    return;
  }
  if (win.chatKey === id) return; // 同じ動画。読み直さない
  win.chatKey = id;
  win.chatReplay = false;
  hideChat(win, '確認中'); // 分かるまでは出さない
  chat.src = 'about:blank';

  MV.runtime
    .sendMessage({ type: 'get-youtube-chat-info', videoId: id })
    .then((r) => {
      if (!wins.includes(win) || win.chatKey !== id) return; // 待つ間に閉じた/別の動画になった
      const info = (r && r.ok && r.info) || { kind: 'none' };
      if (info.kind === 'none') { hideChat(win, 'なし'); return; }
      // 読み直しのたびに弾幕の監視を掛け直す(映像側の frame と同じ扱い)。
      chat.addEventListener('load', () => syncFrameDanmaku(win), { once: true });
      if (info.kind === 'replay') {
        win.chatReplay = true;
        chat.src =
          'https://www.youtube.com/live_chat_replay?continuation=' + encodeURIComponent(info.continuation) +
          '&embed_domain=' + encodeURIComponent(location.hostname) + '&dark_theme=1'; // 白飛び回避
      } else {
        chat.src = toYouTubeChatUrl(win.url);
      }
      showChat(win);
    })
    .catch(() => hideChat(win, 'なし'));
}

// チャットが「使える/使えない」と分かった時に呼ぶ。出すかどうかは枠の設定(win.chatOn)が決めるので、
// ここでは中身の有無だけを更新して、見せ方は syncChatVisibility に任せる。
// 💬 は「チャットがある枠」でだけ押せるようにする。
function showChat(win) {
  win.chatUnavailable = false;
  win.chatPending = false;
  if (win.chatBtn) win.chatBtn.title = 'チャットの表示/非表示';
  syncChatVisibility(win);
}

// why: 'なし'=この配信にチャットが無い / '確認中'=まだ分からない(分かるまでは出さない。
// 先に出して畳むと画面がガタつくため)。
function hideChat(win, why) {
  win.chatUnavailable = why === 'なし';
  win.chatPending = why === '確認中';
  if (win.chatBtn) win.chatBtn.title = why === 'なし' ? 'この動画にはチャットがありません' : 'チャットを確認しています';
  syncChatVisibility(win);
}

// 枠の iframe を作り直す(軽量⇄通常の切替・再読込用)。休止中なら次の表示時に反映される。
function remountFrame(win) {
  if (win.frame) {
    win.frame.remove();
    win.frame = null;
  }
  if (!win.hidden) mountSiteFrame(win);
}

// 枠をその場で再読込する(🔄)。iframe を作り直す。
function reloadWindow(win) {
  if (win.frame) remountFrame(win); // 現在の win.url(と軽量モード)で iframe を作り直す
  // チャットは映像とは別のフレームなので、映像だけ作り直しても止まったままになる。
  // 「再読み込み」を押す場面はたいていチャットが固まった時なので、こちらも読み直す。
  reloadChatFrame(win);
}

// チャット列のフレームだけを読み直す。src を入れ直すと、ログインCookieを通す経路
// (loadFrameWithLogin)も含めて最初からやり直せる。
function reloadChatFrame(win) {
  const chat = win.chatFrame;
  if (!chat) return;
  const src = chat.getAttribute('src');
  if (!src || src === 'about:blank') return; // まだ中身を持っていない(チャット無しの枠)
  const domain = loginDomainOf(hostOf(src));
  chat.src = 'about:blank';
  if (domain) loadFrameWithLogin(chat, domain, src);
  else chat.src = src;
}

// 元サイトを新しいタブで開く。フル機能を本物のサイトで使いたい時の導線。
function openOriginal(win) {
  try {
    MV.tabs.create({ url: win.url });
  } catch (e) {
    window.open(win.url, '_blank', 'noopener');
  }
}

// まだ読み込んでいない枠(起動時に隠れた状態で復元された枠)を win.url から読み込む。読込済みなら何もしない。
function resumeMedia(win) {
  if (!win.frame) mountSiteFrame(win);
}

// ====== 読み込み中スピナー / 遅延読み込み ======

// 枠の中身(映像)の上に読み込み中スピナーを出す/消す。表示は枠の body に重ねる。
function showWinLoading(win) {
  if (!win.body || win.loadingEl) return;
  const el = document.createElement('div');
  el.className = 'win-loading';
  const sp = document.createElement('div');
  sp.className = 'win-spinner';
  const label = document.createElement('div');
  label.className = 'win-loading-label';
  label.textContent = '読み込み中…';
  el.append(sp, label);
  win.body.appendChild(el);
  win.loadingEl = el;
}
function hideWinLoading(win) {
  if (win.loadingTimer) { clearTimeout(win.loadingTimer); win.loadingTimer = null; }
  if (win.loadingEl) { win.loadingEl.remove(); win.loadingEl = null; }
}

// 遅延読み込み(deferLoad)で待たせていた枠の中身を、今このタイミングで読み込む。
// スピナーは読み込み完了(iframe load)か、保険タイマーで消す。
function loadWindowMedia(win) {
  if (!win || !win.pendingLoad) return;
  win.pendingLoad = false;
  // iframe は mountSiteFrame の load ハンドラが hideWinLoading を呼ぶ。
  win.loadingTimer = setTimeout(() => hideWinLoading(win), LOAD_SPINNER_FALLBACK_MS);
  resumeMedia(win);
}
