// 対応サイトの定義と、URL の判定・変換。

// 対応サイトの定義。サイトごとの情報はここに集める。
//   url: 「枠を追加」のボタンで開くトップ / hosts: このサイトのドメイン(サブドメインも含む)
//   login: 枠の中でログイン状態を使う(Cookie の SameSite を緩める)か。YouTube は埋め込みログインの
//          仕組みが別で、緩和がむしろ逆効果になりうるので対象にしない。
//          Kick は配信を選ぶ一覧を枠で開くので、ログインしていないとフォロー中が出ない。
const SITES = {
  twitch: { name: 'Twitch', letter: 'T', color: '#9147ff', url: 'https://www.twitch.tv/', hosts: ['twitch.tv'], login: true },
  youtube: { name: 'YouTube', letter: 'Y', color: '#ff0033', url: 'https://www.youtube.com/', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], login: false },
  kick: { name: 'Kick', letter: 'K', color: '#53fc18', url: 'https://kick.com/', hosts: ['kick.com'], login: true },
  openrec: { name: 'mellow-fan', letter: 'M', color: '#ffd200', url: 'https://www.mellow-fan.com/', hosts: ['mellow-fan.com', 'openrec.tv'], login: true }
};

function hostMatches(host, domain) {
  const h = String(host || '').toLowerCase();
  return h === domain || h.endsWith('.' + domain);
}

// ホスト名から SITES のキーを返す。対応サイトでなければ null。
function siteKeyOf(host) {
  return Object.keys(SITES).find((key) => SITES[key].hosts.some((d) => hostMatches(host, d))) || null;
}

// 視聴ページを持つ YouTube のホストか(youtube-nocookie.com は埋め込み専用なので含めない)。
function isYouTubeWatchHost(host) {
  return host === 'youtu.be' || hostMatches(host, 'youtube.com');
}

// 枠(iframe)に表示できるサイト。rules.json が X-Frame-Options / CSP を剥がしている対象と
// 一致させること。ここに無いサイトは、サイト側の埋め込み拒否がそのまま効いて「接続拒否」になる。
// 対象を増やすことは、そのドメインの埋め込み防御を利用者のブラウザで外すことを意味するので、
// 安易に足さない(README の「この拡張がブラウザに与える影響」も合わせて更新すること)。
const EMBEDDABLE_HOSTS = Object.values(SITES).flatMap((site) => site.hosts);
function isEmbeddableHost(host) {
  return EMBEDDABLE_HOSTS.some((d) => hostMatches(host, d));
}

// 枠として読み込んでよい URL か(スキームとホストの両方を見る)。
// http(s) 以外を弾くのは、UI ページを通常オリジンへ置いてページ側の CSP が無くなったため、
// javascript: 等がこのページの文脈で実行されうるのを防ぐため。
function isAllowedFrameUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return isEmbeddableHost(u.hostname);
  } catch (e) {
    return false;
  }
}

// 別サイトのリンクから渡された配信 URL を取り出す(?add=<配信URL> を、配信の数だけ並べて渡す)。
// 枠に表示できない URL と重複は捨て、枠数の上限で切る。
function addedUrlsFrom(search) {
  const urls = [];
  new URLSearchParams(search).getAll('add').forEach((raw) => {
    const url = String(raw || '').trim();
    if (isAllowedFrameUrl(url) && !urls.includes(url)) urls.push(url);
  });
  return urls.slice(0, MAX_WINDOWS);
}

// 受け取った ?add= を URL から消す。残したままだと、再読み込みのたびに並びを置き換えてしまう。
// ほかのパラメータ(?dev=1)とハッシュ(#stack)は残す。
function dropAddedUrls() {
  const params = new URLSearchParams(location.search);
  if (!params.has('add')) return;
  params.delete('add');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// ====== Kick ======

function kickChannelOf(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0] || '';
  } catch (e) {
    return '';
  }
}

// kick.com のうち「配信ページ」だけを拾う(トップ・一覧・検索などはチャンネルではない)。
// 配信ページなら チャンネル名 を、それ以外なら '' を返す。
const KICK_NON_CHANNEL = [
  'browse', 'categories', 'category', 'following', 'search', 'popout', 'clips',
  'subscriptions', 'messages', 'dashboard', 'about', 'help', 'faq', 'terms', 'privacy'
];
function kickWatchChannel(url) {
  if (siteKeyOf(hostOf(url)) !== 'kick') return '';
  const ch = kickChannelOf(url);
  return ch && !KICK_NON_CHANNEL.includes(ch.toLowerCase()) ? ch : '';
}

// ====== URL ヘルパ ======

// 軽量プレイヤー(⚡)用: 視聴ページの URL を各サイトの公式埋め込みプレイヤー URL に変換する。
// フルサイトの SPA を丸ごと読まずプレイヤーだけになるので、1枠あたりの負荷が大きく下がる。
// 変換先が無い URL(サイトのトップ・一覧ページ等)は null(=切替不可)。
// YouTube の視聴ページ(www.youtube.com/watch)は、別オリジンの iframe に入れて再生すると
// Chromium のレンダラが落ちる。枠 1 つ・iframe の属性も無しの最小構成で 6/6 再現し、
// 例外もクラッシュ位置も毎回同一だった(2026-08-03 実測)。こちらの JS では触れない層なので、
// YouTube は公式に埋め込みが認められている 2 つの口だけで組む。
//   映像   : youtube.com/embed/<ID>
//   チャット: youtube.com/live_chat?v=<ID>&embed_domain=<このページのホスト>
function youtubeVideoIdOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (!isYouTubeWatchHost(host)) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (host === 'youtu.be') return segs[0] || null;
    if (segs[0] === 'watch') return u.searchParams.get('v');
    if (segs[0] === 'live' || segs[0] === 'shorts' || segs[0] === 'embed') return segs[1] || null;
    return null;
  } catch (e) {
    return null;
  }
}

// ライブ/プレミアの公式チャット枠。アーカイブは live_chat_replay へ転送され、
// チャットの無い動画では「利用できない」旨がその枠に出る(💬 で畳める)。
function toYouTubeChatUrl(url) {
  const id = youtubeVideoIdOf(url);
  if (!id) return null;
  // dark_theme=1 を付けないと白基調で描かれ、暗いこのページの中で白飛びして見える。
  return (
    'https://www.youtube.com/live_chat?v=' + encodeURIComponent(id) +
    '&embed_domain=' + encodeURIComponent(location.hostname) + '&dark_theme=1'
  );
}

// Twitch のチャンネル名(配信ページのときだけ)。VOD や一覧ページでは null。
const TWITCH_NON_CHANNEL = ['directory', 'search', 'settings', 'subscriptions', 'inventory', 'drops', 'wallet', 'turbo', 'jobs', 'p', 'videos', 'embed', 'popout'];
function twitchChannelOf(url) {
  try {
    const u = new URL(url);
    if (siteKeyOf(u.hostname) !== 'twitch' || u.hostname.startsWith('player.')) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length || TWITCH_NON_CHANNEL.includes(segs[0])) return null;
    return segs[0];
  } catch (e) {
    return null;
  }
}

// Twitch が埋め込み用に用意しているチャット。parent は埋め込み元のホスト名。
// サイト全体を出すとレイアウトも書き込みもサイト側の都合に振り回されるので、こちらを使う。
function toTwitchChatUrl(url) {
  const ch = twitchChannelOf(url);
  if (!ch) return null;
  return (
    'https://www.twitch.tv/embed/' + encodeURIComponent(ch) + '/chat?darkpopout&parent=' +
    encodeURIComponent(location.hostname)
  );
}

function toLightUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  const host = u.hostname;
  const segs = u.pathname.split('/').filter(Boolean);

  // 自動再生は「ミュート付き」で要求する。モバイルは音あり自動再生が禁止のため、ミュート無しだと
  // 一時停止で止まったまま開く。本アプリは元々「起動時は全ミュート」方針なので挙動も一致する。
  const siteKey = siteKeyOf(host);
  if (isYouTubeWatchHost(host)) {
    const id = youtubeVideoIdOf(url);
    if (!id) return null;
    // enablejsapi: 親が再生位置を受け取るため(アーカイブのチャット再生の同期に使う)。
    // start: 元の URL に ?t=6916s のような指定があれば引き継ぐ(その位置を見たくて貼るため)。
    const t = String(u.searchParams.get('t') || u.searchParams.get('start') || '').match(/^(\d+)/);
    return (
      'https://www.youtube.com/embed/' + encodeURIComponent(id) +
      '?autoplay=1&playsinline=1&mute=1&enablejsapi=1&widgetid=1' +
      (t ? '&start=' + t[1] : '')
    );
  }

  if (siteKey === 'twitch') {
    if (host.startsWith('player.')) return null; // 既に埋め込みプレイヤー
    // parent は埋め込み元ホスト名(=拡張ID)。検証用の frame-ancestors CSP は rules.json が
    // sub_frame で剥がすため、形式さえ合っていれば拡張ページからでも再生できる(実機確認済み)。
    const tail = '&autoplay=true&muted=true&parent=' + encodeURIComponent(location.hostname);
    if (segs[0] === 'videos' && segs[1]) {
      return 'https://player.twitch.tv/?video=' + encodeURIComponent(segs[1]) + tail;
    }
    const nonChannel = ['directory', 'search', 'settings', 'subscriptions', 'inventory', 'drops', 'wallet', 'turbo', 'jobs', 'p'];
    if (segs.length && !nonChannel.includes(segs[0])) {
      return 'https://player.twitch.tv/?channel=' + encodeURIComponent(segs[0]) + tail;
    }
    return null;
  }

  if (siteKey === 'kick') {
    const channel = kickWatchChannel(url);
    return channel ? 'https://player.kick.com/' + encodeURIComponent(channel) + '?autoplay=true&muted=true' : null;
  }

  // mellow-fan(旧 OPENREC)。URL 形式は改名後も /live/<id> ・ /movie/<id> のまま。
  if (siteKey === 'openrec') {
    if ((segs[0] === 'live' || segs[0] === 'movie') && segs[1]) {
      return 'https://www.mellow-fan.com/embed/' + encodeURIComponent(segs[1]);
    }
    return null;
  }

  return null;
}

function labelFor(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname;
  } catch (e) {
    return url;
  }
}

// URL を「サイト部分」と「チャンネル名/識別子」に分ける。一覧でその部分を強調するため。
//  例: twitch.tv/jun_channel → { site:'twitch.tv/', name:'jun_channel' }
//      youtube.com/watch?v=ABcd → { site:'youtube.com/', name:'ABcd' }(watch だけにせず動画IDを出す)
function channelParts(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const segs = u.pathname.split('/').filter(Boolean);
    let name = '';
    const siteKey = siteKeyOf(host);
    if (siteKey === 'youtube') {
      if (host === 'youtu.be') name = segs[0] || '';
      else if (segs[0] === 'watch') name = u.searchParams.get('v') || 'watch';
      else if (['live', 'shorts', 'embed'].includes(segs[0])) name = segs[1] || segs[0];
      else name = segs[0] || '';
    } else if (siteKey === 'openrec') {
      name = segs[segs.length - 1] || '';
    } else if (host.startsWith('player.twitch')) {
      name = u.searchParams.get('channel') || u.searchParams.get('video') || '';
    } else {
      name = segs[0] || ''; // twitch / kick: 最初のセグメント = チャンネル名
    }
    return { site: host + (name ? '/' : ''), name };
  } catch (e) {
    return { site: '', name: url };
  }
}

// URL からサイトを判定し、一覧用の色・頭文字・名前を返す。
function siteOf(url) {
  const h = hostOf(url);
  return SITES[siteKeyOf(h)] || { letter: '•', color: '#6e7681', name: h || 'その他' };
}
