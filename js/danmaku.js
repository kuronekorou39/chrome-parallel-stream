// コメント弾幕と、その設定パネル。

// ====== コメント弾幕 ======
// 各枠の content script(stream-control.js)がチャットDOMから拾ったコメントを postMessage で送ってくる。
// ここでは枠ごとにオーバーレイ層(.win-danmaku)を重ね、DOM要素+WAAPI で右→左へ流す。レーン(行)を
// 割り当て、前の弾幕が十分先へ進んだ行にだけ次を出して重なりを避ける。OFF の枠・隠し枠には流さない。

function onChatMessage(e) {
  const d = e.data;
  if (!d || d[MAGIC] !== true || d.type !== 'chat-message') return;
  // コメントの出どころは、サイトを丸ごと出している枠か、横に並べたチャット枠のどちらか。
  // YouTube は埋め込みプレイヤー+ live_chat の2枚組なので、映像側だけを見ると取りこぼす。
  const win = wins.find(
    (w) =>
      (w.frame && w.frame.contentWindow === e.source) ||
      (w.chatFrame && w.chatFrame.contentWindow === e.source)
  );
  if (!win || !win.danmaku.on || win.hidden) return;
  // parts(テキスト/絵文字画像のセグメント配列)。旧 text 形式が来ても一応扱える。
  const parts = Array.isArray(d.parts) ? d.parts : (d.text ? [{ text: String(d.text) }] : []);
  spawnDanmaku(win, parts, d.color || '');
}

// 枠に弾幕オーバーレイ層を用意(無ければ作る)。映像と同座標で、CSS filter の影響を受けない位置に置く。
function ensureDanmakuLayer(win) {
  if (win.danmaku.layer && win.danmaku.layer.isConnected) return win.danmaku.layer;
  // 2分割の枠(Kick / YouTube)は映像側にだけ重ねる。body に重ねるとチャット列の上も覆ってしまう。
  const parentEl = win.body.querySelector('.win-media') || win.body;
  const layer = document.createElement('div');
  layer.className = 'win-danmaku';
  parentEl.appendChild(layer);
  win.danmaku.layer = layer;
  win.danmaku.lanes = [];
  return layer;
}
function clearDanmakuLayer(win) {
  if (win.danmaku.layer) { try { win.danmaku.layer.remove(); } catch (e) { /* noop */ } }
  win.danmaku.layer = null;
  win.danmaku.lanes = [];
}

// 枠の実効設定 = 全体の既定(dmkGlobal)に、その枠の上書き(overrides)を重ねたもの。
function dmkSettings(win) {
  return Object.assign({}, dmkGlobal, (win && win.danmaku && win.danmaku.overrides) || {});
}
// この枠の実効設定が全体の既定と1つでも違うか(↺・●・解除ボタンの出し分けに使う。
// 「overrides にキーがあるか」ではなく「実際に値が違うか」で見る=全体と同値の上書きは個別扱いしない)。
function dmkHasDiff(win) {
  if (!win || !win.danmaku) return false;
  const eff = dmkSettings(win);
  return DMK_CONTROLS.some((c) => eff[c.key] !== dmkGlobal[c.key]);
}
// 色文字列(#rgb / #rrggbb / rgb()) を [r,g,b] に。失敗は null。
function dmkParseColor(c) {
  if (!c) return null;
  c = String(c).trim();
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) { return m[1].split('').map((h) => parseInt(h + h, 16)); }
  m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(',').map((x) => parseInt(x, 10)); if (p.length >= 3 && p.every((v) => !isNaN(v))) return [p[0], p[1], p[2]]; }
  return null;
}
// ユーザー色を白とブレンド(strength 0=白 / 100=原色)。取れなければ白。
function dmkBlendColor(color, strength) {
  const rgb = dmkParseColor(color);
  if (!rgb) return '#fff';
  const t = Math.max(0, Math.min(100, strength)) / 100;
  const mix = (v) => Math.round(255 * (1 - t) + v * t);
  return 'rgb(' + mix(rgb[0]) + ',' + mix(rgb[1]) + ',' + mix(rgb[2]) + ')';
}

// 空いているレーン番号を返す(前の弾幕の末尾が GAP 以上左へ進んだ行)。laneH は枠の実効サイズで決まる。
function pickDanmakuLane(win, layerH, laneH) {
  const laneCount = Math.max(1, Math.floor(layerH / laneH));
  const lanes = win.danmaku.lanes;
  const now = performance.now();
  for (let i = 0; i < laneCount; i++) {
    const ln = lanes[i];
    if (!ln) return i; // 未使用の行
    const traveled = ((now - ln.start) / 1000) * ln.speed; // 前の弾幕が左へ進んだ距離
    if (traveled >= ln.width + DMK_GAP) return i;           // 末尾が十分先=この行は空き
  }
  return -1;
}

// parts(テキスト/絵文字画像)からノードの中身を組み立てる。絵文字は <img> で描画(https のみ・枚数上限)。
function dmkBuildNode(node, parts, fontSize) {
  let textLen = 0, imgs = 0;
  for (const p of parts) {
    if (p && p.text != null) {
      let t = String(p.text);
      if (textLen + t.length > 200) t = t.slice(0, 200 - textLen);
      if (t) { node.appendChild(document.createTextNode(t)); textLen += t.length; }
    } else if (p && p.img && imgs < 24) {
      const src = String(p.img);
      if (!/^https:\/\//i.test(src)) continue; // https の画像のみ(安全)
      const img = document.createElement('img');
      img.className = 'dmk-emote';
      img.src = src;
      img.alt = p.alt || '';
      img.referrerPolicy = 'no-referrer';
      img.style.height = Math.round(fontSize * 1.25) + 'px'; // 行内に収まる絵文字サイズ
      node.appendChild(img);
      imgs++;
    }
    if (textLen >= 200) break;
  }
}

function spawnDanmaku(win, parts, color) {
  if (!win.danmaku.on || win.hidden || !parts || !parts.length) return;
  const layer = ensureDanmakuLayer(win);
  const layerW = layer.clientWidth, layerH = layer.clientHeight;
  if (!layerW || !layerH) return;
  if (layer.childElementCount >= DMK_MAX_NODES) return; // 暴発保険
  const s = dmkSettings(win);
  // 長さ(テキスト+絵文字alt)で 長文縮小・速度 を決める
  let plain = '';
  for (const p of parts) plain += (p && p.text != null ? p.text : (p && p.alt) || '');
  const len = plain.length || 1;
  // 長文を縮小: しきい値を超えると長いほど小さく(荒らし長文を見づらく)
  let scale = 1;
  if (s.longShrink && len > s.longShrinkThreshold) scale = Math.max(DMK_MIN_SCALE, s.longShrinkThreshold / len);
  const fontSize = Math.max(8, Math.round(s.fontSize * scale));
  const laneH = Math.round(s.fontSize * 1.4); // 行高は基準サイズで固定(縮小ノードも同じ行に収まる)
  // 長さで速度: 長いほど速く流す
  let speed = s.speed;
  if (s.speedByLength) speed = Math.round(s.speed * Math.min(DMK_SPEED_MAX_FACTOR, Math.max(1, len / DMK_SPEED_REF_LEN)));
  // 色: 使う設定 かつ 色が取れたらブレンド、それ以外は白
  const col = (s.useColor && color) ? dmkBlendColor(color, s.colorStrength) : '#fff';

  const node = document.createElement('div');
  node.className = 'dmk';
  node.style.color = col;
  node.style.fontSize = fontSize + 'px';
  node.style.lineHeight = laneH + 'px';
  dmkBuildNode(node, parts, fontSize); // テキスト+絵文字画像を組み立て
  if (!node.childNodes.length) return; // 中身が無ければ出さない
  node.style.visibility = 'hidden'; // 幅計測のため一旦不可視で配置(レイアウトは効く)
  layer.appendChild(node);
  layer.style.opacity = s.opacity / 100; // 設定変更も都度反映
  // 絵文字画像は非同期ロードのため、幅を正しく測るには decode を待つ必要がある。
  // 画像があれば decode 完了(or 800ms 打ち切り)後に流す。テキストのみなら即流す。
  const imgs = node.getElementsByTagName('img');
  if (imgs.length) {
    Promise.race([
      Promise.all(Array.prototype.map.call(imgs, (im) => im.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, 800))
    ]).then(() => dmkLaunchNode(win, node, layer, layerW, laneH, speed));
  } else {
    dmkLaunchNode(win, node, layer, layerW, laneH, speed);
  }
}

// 計測→レーン割当→右→左アニメ。絵文字画像の decode 待ちの後に呼ばれることがあるので、
// 既に枠が消えている/中身が無いケースに備えて防御する。
function dmkLaunchNode(win, node, layer, layerW, laneH, speed) {
  if (!node.isConnected || !win.danmaku.on) { try { node.remove(); } catch (e) { /* noop */ } return; }
  const layerH = layer.clientHeight;
  const nodeW = node.offsetWidth;
  const lane = pickDanmakuLane(win, layerH, laneH);
  if (lane < 0) { node.remove(); return; } // 空き行が無ければ捨てる(重なり防止)
  node.style.top = (lane * laneH) + 'px';
  node.style.visibility = '';
  win.danmaku.lanes[lane] = { start: performance.now(), width: nodeW, speed };
  const dur = ((layerW + nodeW) / speed) * 1000;
  const anim = node.animate(
    [{ transform: 'translateX(' + layerW + 'px)' }, { transform: 'translateX(' + (-nodeW) + 'px)' }],
    { duration: dur, easing: 'linear' }
  );
  const done = () => { try { node.remove(); } catch (e) { /* noop */ } };
  anim.onfinish = done;
  anim.oncancel = done;
}

// 枠ごとの弾幕 ON/OFF(⋮メニューから)。ON で層を用意し、子(content script)へ監視開始/停止を伝える。
function toggleDanmaku(win) {
  win.danmaku.on = !win.danmaku.on;
  if (win.danmaku.on) ensureDanmakuLayer(win);
  else clearDanmakuLayer(win);
  sendDanmakuEnabled(win, win.danmaku.on);
  syncChatVisibility(win); // 畳んでいるチャットを取得元として生かす/やめる
  syncMenuLabels(win);
}
function sendDanmakuEnabled(win, on) {
  // コメントを持っているのは、サイトを丸ごと出している枠か、横に並べたチャット枠のどちらか。
  // YouTube は埋め込みプレイヤー+ live_chat の2枚組なので、映像側だけに送ると届かない。
  [win.frame, win.chatFrame].forEach((f) => postToFrame(f, { type: 'set-danmaku-enabled', value: !!on }));
}
// frame の読込/挨拶のすれ違い対策。現在の弾幕状態を frame へ送り直す(theater と同型)。
function syncFrameDanmaku(win) {
  sendDanmakuEnabled(win, win.danmaku.on);
}

// 保存値の検証: 既知キーだけを範囲内に収めて取り込む(壊れた storage 値で暴れない)。
function dmkSanitize(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  DMK_CONTROLS.forEach((c) => {
    if (!(c.key in o)) return;
    if (c.type === 'toggle') out[c.key] = !!o[c.key];
    else { const v = Number(o[c.key]); if (Number.isFinite(v)) out[c.key] = Math.max(c.min, Math.min(c.max, Math.round(v))); }
  });
  return out;
}

// ====== 弾幕設定パネル(全体の既定 / この枠の上書き) ======
// 状態(dmkPanelWin / dmkPanelControls)は init より前で初期化済み(ファイル先頭)。

// 編集を反映先へ書き込む。global なら dmkGlobal、win なら activeWin.danmaku.overrides。
function dmkEditValue(key, value) {
  if (dmkPanelWin) {
    dmkPanelWin.danmaku.overrides = dmkPanelWin.danmaku.overrides || {};
    dmkPanelWin.danmaku.overrides[key] = value;
  } else {
    dmkGlobal[key] = value;
  }
  applyDanmakuSettings();
}
// 不透明度など即時に見た目へ反映すべき設定を各層へ当てる(速度・色・サイズ等は次の弾幕から効く)。
function applyDanmakuSettings() {
  wins.forEach((w) => { if (w.danmaku.layer) w.danmaku.layer.style.opacity = dmkSettings(w).opacity / 100; });
}
// 適用先ドロップダウンの選択肢を「全体の既定 + 各枠」で作り直し、現在の対象を選択。
// 個別設定のある枠には ● を付けて分かるようにする。対象枠が閉じられていたら全体へ戻す。
function populateDmkScope() {
  const sel = document.getElementById('dmk-scope');
  if (!sel) return;
  const want = dmkPanelWin ? String(dmkPanelWin.id) : 'global';
  sel.innerHTML = '';
  const og = document.createElement('option');
  og.value = 'global'; og.textContent = '全体の既定';
  sel.appendChild(og);
  wins.forEach((w) => {
    const o = document.createElement('option');
    o.value = String(w.id);
    o.textContent = winLabel(w) + (dmkHasDiff(w) ? ' ●' : ''); // ● = 全体と違う個別設定あり
    sel.appendChild(o);
  });
  sel.value = want;
  if (sel.value !== want) { dmkPanelWin = null; sel.value = 'global'; } // 対象枠が消えていた
}
// 値に一番近い段階のインデックスを返す。
function nearestStepIndex(steps, value) {
  const v = Number(value);
  let best = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - v) < Math.abs(steps[best] - v)) best = i;
  }
  return best;
}

// パネルの各コントロールを現在の対象(全体の既定 or その枠の実効値)に合わせて描き直す。
function renderDanmakuPanel() {
  if (dmkPanelWin && !wins.includes(dmkPanelWin)) dmkPanelWin = null; // 閉じられた枠は全体へ
  const src = dmkPanelWin ? dmkSettings(dmkPanelWin) : dmkGlobal;
  DMK_CONTROLS.forEach((c) => {
    const ui = dmkPanelControls[c.key];
    if (!ui) return;
    if (c.type === 'toggle') {
      const on = !!src[c.key];
      ui.input.classList.toggle('on', on);
      ui.input.textContent = on ? 'ON' : 'OFF';
    } else if (ui.steps) {
      // 保存値が段階とぴったり一致しないこと(旧設定・プリセット)もあるので、一番近い段階に寄せる。
      const i = nearestStepIndex(ui.steps, src[c.key]);
      ui.input.value = String(i);
      ui.input.title = ui.stepNames[i];
    } else {
      ui.input.value = src[c.key];
      ui.valEl.textContent = src[c.key] + (c.unit || '');
    }
    if (ui.revert) ui.revert.classList.toggle('is-hidden', !(dmkPanelWin && src[c.key] !== dmkGlobal[c.key])); // 全体と実際に違う項目だけ ↺ を可視化(場所は常に確保)
  });
  populateDmkScope();
  renderDmkOnOff();
  // 適用先をタイトルにも出す。⋮ から開くと「その枠だけ」になるが、適用先の行だけだと気づかず
  // 「全体を変えたつもりが枠の上書きになっていた(=全体で開き直すと元のまま)」が起きるため。
  const titleEl = document.querySelector('#danmaku-panel .dmk-title');
  // 枠名まで入れると 300px 幅では見出しが切れる。どちらを編集中かだけを短く出し、
  // どの枠かは真下の「適用先」で見せる。
  if (titleEl) putLabel(titleEl, dmkPanelWin ? ':danmaku: 弾幕設定(この枠だけ)' : ':danmaku: 弾幕設定(全体)');
  const panelEl = document.getElementById('danmaku-panel');
  if (panelEl) panelEl.classList.toggle('scope-win', !!dmkPanelWin); // 枠選択中は適用先の行を目立たせる
  const resetBtn = document.getElementById('dmk-reset');
  if (resetBtn) {
    if (dmkPanelWin) { // 枠: 全体と違う設定がある時だけ「解除」を出す
      resetBtn.textContent = 'この枠の個別設定を解除';
      resetBtn.hidden = !dmkHasDiff(dmkPanelWin);
    } else { // 全体: いつでも初期値へ戻せる
      resetBtn.textContent = '初期値に戻す';
      resetBtn.hidden = false;
    }
  }
}
// 適用先に応じた弾幕 ON/OFF。枠選択中=その枠のトグル / 全体=全枠まとめて ON/OFF。
function renderDmkOnOff() {
  const box = document.getElementById('dmk-onoff');
  if (!box) return;
  box.innerHTML = '';
  if (dmkPanelWin) {
    const label = document.createElement('span');
    label.className = 'dmk-onoff-label';
    label.textContent = 'この枠の弾幕';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dmk-toggle';
    const on = !!dmkPanelWin.danmaku.on;
    btn.classList.toggle('on', on);
    btn.textContent = on ? 'ON' : 'OFF';
    btn.addEventListener('click', () => { toggleDanmaku(dmkPanelWin); renderDanmakuPanel(); saveLineup(); });
    box.append(label, btn);
  } else {
    const label = document.createElement('span');
    label.className = 'dmk-onoff-label';
    label.textContent = '弾幕(全枠)';
    const onBtn = document.createElement('button');
    onBtn.type = 'button'; onBtn.className = 'dmk-bulk'; onBtn.textContent = 'すべてON';
    onBtn.addEventListener('click', () => setAllDanmaku(true));
    const offBtn = document.createElement('button');
    offBtn.type = 'button'; offBtn.className = 'dmk-bulk'; offBtn.textContent = 'すべてOFF';
    offBtn.addEventListener('click', () => setAllDanmaku(false));
    box.append(label, onBtn, offBtn);
  }
}
function setAllDanmaku(on) {
  danmakuDefaultOn = on; // 次に追加される枠にも効かせる
  wins.forEach((w) => { if (!!w.danmaku.on !== on) toggleDanmaku(w); });
  syncMainMenuToggles();
  saveLineup();
}
// プリセット: 現在の適用先の実効値を名前付きで保存し、選んで適用/削除(MV.storage で全体共有)。
function renderDmkPresets() {
  const sel = document.getElementById('dmk-preset-sel');
  if (!sel) return;
  sel.innerHTML = '';
  if (!dmkPresets.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '(プリセットなし)';
    sel.appendChild(o);
    return;
  }
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = '(選択)';
  sel.appendChild(o0);
  dmkPresets.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = p.name;
    sel.appendChild(o);
  });
}
function saveDmkPresets() {
  try { MV.storage.local.set({ [DMK_PRESETS_KEY]: dmkPresets }); } catch (e) { /* noop */ }
}
function dmkPresetSave() {
  const name = (window.prompt('プリセット名', '') || '').trim();
  if (!name) return;
  const src = dmkPanelWin ? dmkSettings(dmkPanelWin) : dmkGlobal;
  dmkPresets.push({ name: name.slice(0, 40), settings: dmkSanitize(src) });
  saveDmkPresets();
  renderDmkPresets();
  document.getElementById('dmk-preset-sel').value = String(dmkPresets.length - 1);
}
function dmkPresetApply() {
  const sel = document.getElementById('dmk-preset-sel');
  if (sel.value === '') return; // プレースホルダ「(選択)」時は何もしない(Number('')===0 で先頭に誤爆するため)
  const p = dmkPresets[Number(sel.value)];
  if (!p) return;
  const s = dmkSanitize(p.settings);
  if (dmkPanelWin) {
    // 枠: プリセット値のうち「全体と違うもの」だけ上書きにする(同値は上書きにせず全体に追従=↺/●を出さない)。
    const ovr = {};
    DMK_CONTROLS.forEach((c) => { if (c.key in s && s[c.key] !== dmkGlobal[c.key]) ovr[c.key] = s[c.key]; });
    dmkPanelWin.danmaku.overrides = ovr;
  } else {
    dmkGlobal = Object.assign({}, DMK_DEFAULTS, s); // 全体: 既定へプリセットを重ねる
  }
  applyDanmakuSettings();
  renderDanmakuPanel();
  saveLineup();
}
function dmkPresetDelete() {
  const sel = document.getElementById('dmk-preset-sel');
  if (sel.value === '') return; // プレースホルダ時は何もしない(Number('')===0 で先頭を消してしまうため)
  const i = Number(sel.value);
  if (!dmkPresets[i]) return;
  dmkPresets.splice(i, 1);
  saveDmkPresets();
  renderDmkPresets();
}
// パネルを開く。win 指定ありなら適用先=その枠(フォーカスもする)、なしなら全体の既定。
function openDanmakuPanel(win) {
  const panel = document.getElementById('danmaku-panel');
  if (!panel) return;
  // 全体対象で開く操作(ツールバー / ≡メニュー)のときの挙動:
  //   枠を対象にして開いている → 全体へ切り替えるだけ(閉じない)
  //   既に全体で開いている     → 閉じる
  // 「枠→全体の切り替え」と「閉じる」を同じ一回の操作にまとめると、枠を見ていたときに
  // 全体設定へ移れなくなるため、段階を分ける。
  // 枠を指定して開くとき(枠のメニュー)は、対象の切り替えが目的なので常に開く。
  if (!win && !panel.hidden) {
    if (dmkPanelWin) { dmkPanelWin = null; renderDanmakuPanel(); return; }
    panel.hidden = true;
    return;
  }
  dmkPanelWin = win || null;
  if (win) focusWindow(win);
  panel.hidden = false;
  raisePanel(panel);
  centerPanel(panel);
  renderDanmakuPanel();
}
// 設定1行(ラベル + つまみ/トグル + ↺)を組み立てて返す。簡易と詳細の両方から使う。
function buildDmkRow(c) {
  {
    const row = document.createElement('div');
    row.className = 'dmk-row';
    const label = document.createElement('span');
    label.className = 'dmk-label';
    label.textContent = c.label;
    row.appendChild(label);
    let ctrl;
    if (c.type === 'toggle') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dmk-toggle';
      btn.addEventListener('click', () => {
        const cur = dmkPanelWin ? dmkSettings(dmkPanelWin) : dmkGlobal;
        dmkEditValue(c.key, !cur[c.key]);
        renderDanmakuPanel();
        saveLineup();
      });
      row.appendChild(btn);
      ctrl = { input: btn };
    } else if (c.steps) {
      // 段階選択。つまみは 0..n-1 のインデックスを動かし、値は steps から引く。
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0'; input.max = String(c.steps.length - 1); input.step = '1';
      // list を付けると Chrome がつまみの下に目盛りを描く(段階があることが見て分かる)。
      const ticks = document.createElement('datalist');
      ticks.id = 'dmk-ticks-' + c.key;
      c.steps.forEach((_, i) => { const o = document.createElement('option'); o.value = String(i); ticks.appendChild(o); });
      input.setAttribute('list', ticks.id);
      // 段階名は表示しない(つまみの幅を削るため)。目盛りと位置で分かるので、名前はツールチップに回す。
      input.addEventListener('input', () => {
        const i = Number(input.value);
        dmkEditValue(c.key, c.steps[i]);
        input.title = c.stepNames[i];
      });
      input.addEventListener('change', () => { saveLineup(); renderDanmakuPanel(); });
      row.append(input, ticks);
      ctrl = { input, steps: c.steps, stepNames: c.stepNames };
    } else {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(c.min); input.max = String(c.max);
      const val = document.createElement('span');
      val.className = 'dmk-val';
      input.addEventListener('input', () => {
        dmkEditValue(c.key, Number(input.value));
        val.textContent = input.value + (c.unit || '');
      });
      input.addEventListener('change', () => { saveLineup(); renderDanmakuPanel(); }); // 離したら保存 + ↺/● を更新
      row.append(input, val);
      ctrl = { input, valEl: val };
    }
    // ↺ 個別リセット: この枠の上書きを1項目だけ全体へ戻す。上書き中のときだけ表示(render で出し分け)。
    const rev = document.createElement('button');
    rev.type = 'button';
    rev.className = 'dmk-revert';
    putLabel(rev, ':revert:');
    rev.title = 'この項目を全体の値に戻す';
    rev.classList.add('is-hidden'); // 既定は不可視(場所は確保=つまみ幅を固定)
    rev.addEventListener('click', () => {
      if (dmkPanelWin && dmkPanelWin.danmaku.overrides) {
        delete dmkPanelWin.danmaku.overrides[c.key];
        applyDanmakuSettings();
        renderDanmakuPanel();
        saveLineup();
      }
    });
    row.appendChild(rev);
    ctrl.revert = rev;
    dmkPanelControls[c.key] = ctrl;
    return row;
  }
}

function setupDanmakuPanel() {
  const panel = document.getElementById('danmaku-panel');
  if (!panel) return;
  const rows = panel.querySelector('.dmk-rows');

  // 簡易: 普段いじる項目だけを、種類の見出しなしで並べる(最初の見た目を軽くする)。
  DMK_CONTROLS.filter((c) => !c.adv).forEach((c) => rows.appendChild(buildDmkRow(c)));

  // 詳細: 既定は畳んでおき、開いたときだけ種類ごとの見出し付きで出す。
  const advWrap = document.createElement('div');
  advWrap.className = 'dmk-adv';
  const advBtn = document.createElement('button');
  advBtn.type = 'button';
  advBtn.className = 'dmk-adv-toggle';
  const advBody = document.createElement('div');
  advBody.className = 'dmk-adv-body';
  advBody.hidden = true;
  const syncAdvBtn = () => { advBtn.textContent = advBody.hidden ? '詳細設定 ▾' : '詳細設定 ▴'; };
  syncAdvBtn();
  advBtn.addEventListener('click', () => { advBody.hidden = !advBody.hidden; syncAdvBtn(); });
  let curGroup = null;
  DMK_CONTROLS.filter((c) => c.adv).forEach((c) => {
    if (c.group && c.group !== curGroup) { // 種類ごとの見出し(サイズ/速度/色/表示)
      curGroup = c.group;
      const h = document.createElement('div');
      h.className = 'dmk-group';
      h.textContent = c.group;
      advBody.appendChild(h);
    }
    advBody.appendChild(buildDmkRow(c));
  });
  // プリセットも詳細側へ移す。常時見えている必要は無く、簡易表示を軽くする。
  const presets = panel.querySelector('.dmk-presets');
  if (presets) advBody.appendChild(presets);
  advWrap.append(advBtn, advBody);
  rows.insertAdjacentElement('afterend', advWrap);

  const scope = document.getElementById('dmk-scope');
  if (scope) scope.addEventListener('change', () => {
    dmkPanelWin = scope.value === 'global' ? null : (wins.find((w) => String(w.id) === scope.value) || null);
    renderDanmakuPanel();
  });
  document.getElementById('dmk-reset').addEventListener('click', () => {
    if (dmkPanelWin) { dmkPanelWin.danmaku.overrides = {}; } // 枠: 個別設定を全解除(全体に追従)
    else { dmkGlobal = Object.assign({}, DMK_DEFAULTS); }    // 全体: 初期値へ
    applyDanmakuSettings();
    renderDanmakuPanel();
    saveLineup();
  });
  document.getElementById('dmk-preset-apply').addEventListener('click', dmkPresetApply);
  document.getElementById('dmk-preset-save').addEventListener('click', dmkPresetSave);
  document.getElementById('dmk-preset-del').addEventListener('click', dmkPresetDelete);
  try {
    MV.storage.local.get(DMK_PRESETS_KEY, (r) => {
      const arr = r && r[DMK_PRESETS_KEY];
      if (!Array.isArray(arr)) { renderDmkPresets(); return; }
      const loaded = arr.filter((p) => p && p.name)
        .map((p) => ({ name: String(p.name).slice(0, 40), settings: dmkSanitize(p.settings) }));
      // 読込を待たずにユーザーが保存していることがある。丸ごと代入すると、その追加分が
      // 画面から消え(storage には残るので次回起動で復活し)挙動が不可解になる。
      // 既にメモリ上にある名前を優先し、保存済みのうち未知のものだけを足す。
      const known = new Set(dmkPresets.map((p) => p.name));
      dmkPresets = dmkPresets.concat(loaded.filter((p) => !known.has(p.name)));
      renderDmkPresets();
    });
  } catch (e) { renderDmkPresets(); }
  document.getElementById('danmaku-close').addEventListener('click', () => { panel.hidden = true; });
  makePanelDraggable(panel, panel.querySelector('.dmk-head'));
  wirePanelRaise(panel); // 掴む/フォーカスで最前面
  const openBtn = document.getElementById('danmaku-settings-btn');
  if (openBtn) openBtn.addEventListener('click', () => openDanmakuPanel(null));
}
