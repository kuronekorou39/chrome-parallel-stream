// 線画アイコン。

// ====== アイコン ======
// 絵文字は使わず、線画の SVG に揃える(絵文字は OS で見た目が変わり、色が付いて目を引くため)。
// どれも 24x24 の枠に線で描いた単純な図形。色は文字色に従う(CSS の .ic)。
const ICON_PATHS = {
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/>',
  sparkle: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
  // 横向きのつまみ 3 本。枠一覧の音量つまみが横向きなので、それに合わせる(以前は縦向きだった)。
  mixer: '<path d="M3 5h7M14 5h7M3 12h3M10 12h11M3 19h10M17 19h4M12 2.5v5M8 9.5v5M15 16.5v5"/>',
  adjust: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  danmaku: '<path d="M3 7h10M9 12h12M5 17h9"/>',
  chat: '<path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z"/>',
  gear: '<circle cx="12" cy="12" r="8.2" stroke-width="3.2" stroke-dasharray="3.2 3.24" stroke-linecap="butt"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.2"/>',
  update: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  perf: '<path d="M5 20v-8M12 20V4M19 20v-5"/>',
  cookie: '<circle cx="12" cy="12" r="9"/><path d="M9 9h.01M15 11h.01M10 15h.01M15 16h.01" stroke-width="2.6"/>',
  // 音量の段階。音の線が 1〜3 本(volIconName で選ぶ)。
  'vol-low': '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>',
  'vol-mid': '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7.5a6.5 6.5 0 0 1 0 9"/>',
  'vol-high': '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7.5a6.5 6.5 0 0 1 0 9M20.5 5a10 10 0 0 1 0 14"/>',
  'vol-off': '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>',
  revert: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  width: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  height: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><path d="M4 4l16 16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  drop: '<path d="M12 3c3.5 4.5 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.5-6.5 6-11z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  // GitHub のロゴ。ここだけ線画ではなく塗り(ロゴは形を変えられないため)。
  github: '<path fill="currentColor" stroke="none" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>'
};
// 軽量プレイヤーの印。title 属性や <option> には SVG を置けないので、ここだけ文字にする
// (U+FE0E を付けて、絵文字ではなく単色の文字として出す)。
const LIGHT_MARK = '\u26A1\uFE0E ';

function iconEl(name) {
  const t = document.createElement('template');
  t.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
  return t.content.firstChild;
}

// 要素の中身を「アイコン + 文字」にする。label が ':名前: 文字' の形ならアイコン付き、
// ':名前:' だけならアイコンのみ、それ以外はただの文字として入れる。
function putLabel(el, label) {
  const m = /^:([a-z-]+):\s*(.*)$/.exec(label);
  if (!m) { el.textContent = label; return; }
  el.replaceChildren(iconEl(m[1]));
  if (m[2]) {
    const text = document.createElement('span');
    text.className = 'ic-text';
    text.textContent = m[2];
    el.appendChild(text);
  }
}

// HTML に置いた目印(<i data-ic="名前">)を SVG に差し替える。
document.querySelectorAll('i[data-ic]').forEach((el) => el.replaceWith(iconEl(el.dataset.ic)));
