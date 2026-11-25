// 「音で合わせる」。

// ====== 音で合わせる ======
// 枠ごとの遅延を、耳で合わせる代わりに音の突き合わせで決める。一緒に配信している人たちの枠には
// 同じ音(通話の声・同じゲームの音・本配信の音)が入っているので、2 枠の音をずらしながら重ねて
// いちばん一致する位置を探せば、枠同士のずれが秒数で出る。全枠をいちばん遅れている枠に揃える
// (早めることはできず、遅らせることしかできないため)。
// 基本は、押したときに一度だけ合わせる。合わせた枠は再生位置を固定するので普段は動かないが、
// 広告明けや回線の詰まりで崩れることがあるため、定期的に合わせ直すこともできる(syncAuto)。
// 定期実行は、ずれが小さければ何もせず、直すときも全体の動きが最小になるように寄せる。
// 聞く長さ。ずれが大きい組ほど、2 枠の録音のうち同じ音が入っている部分が短くなる
// (ずれ 15 秒なら 20 秒中の 5 秒だけ)。本配信とミラーの差は 6〜12 秒あった(実測)ので、
// それでも重なりが残る長さにする。
const SYNC_LISTEN_MS = 20000;
const SYNC_MIN_SEC = 8;       // 全枠の録音が重なる区間がこれより短ければ、測らない
const SYNC_MAX_LAG_SEC = 15;  // 探すずれの範囲(±)
// 一致の山が、ほかの位置の最大の何倍あれば「同じ音が入っている」とみなすか。
// 実測では、同じ音が入っている組は 6〜25 倍、無関係な組は 1.0〜1.2 倍だった。
const SYNC_MIN_RATIO = 3;
const SYNC_STATUS_MS = 30000; // メニューに出した結果を消すまでの時間
const SYNC_AUTO_GAP_MS = 300000; // 定期実行で、測り終えてから次に聞き始めるまでの間隔(5 分)
// 定期実行は、この回数で自動的にオフにする(5 分おき × 12 回 ≒ 1 時間)。合わせたい配信が
// 終わった後も、気づかないまま測り続けることが無いようにするため。
const SYNC_AUTO_MAX_RUNS = 12;
// 定期実行で、これ未満のずれは直さない。枠側が遅延を保つ精度(±0.03 秒)より細かく直そうとすると、
// 毎回わずかに動かし続けることになる。
const SYNC_AUTO_MIN_STEP = 0.06;
let syncStatusTimer = 0;
let syncAuto = false; // 定期的に合わせ直すか(その場かぎり。保存しない)
let syncAutoLeft = 0; // 定期実行の残り回数
let syncAutoTimer = 0;
let syncRun = null; // 聞いている最中だけ { caps: Map(win → 録音) }
let syncDialogRan = false; // ダイアログを開いてから実行したか(定期実行の案内を出す条件)

// 高速フーリエ変換(その場で書き換える。長さは 2 のべき乗)。
function fftInPlace(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? -1 : 1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// 同じ時刻から始まる同じ長さの音 a, b について、b が a より何秒遅れているかを出す。
// 相互相関を周波数ごとの強さで割って位相だけで比べる(GCC-PHAT)。こうすると、片方にだけ
// 乗っている声や、音量・音質の違いに引きずられにくく、山が鋭く出る。
// ratio = 山の高さ ÷ ほかの位置(山の前後 1 秒を除く)の最大。大きいほど確か。
function audioLag(a, b, rate, maxLagSec) {
  let n = 1;
  while (n < a.length * 2) n <<= 1; // 2 倍に取って、ずらしたときに反対側から回り込まないようにする
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(a);
  br.set(b);
  fftInPlace(ar, ai, false);
  fftInPlace(br, bi, false);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const m = ar[i] * bi[i] - ai[i] * br[i];
    const g = Math.hypot(r, m) + 1e-12;
    ar[i] = r / g;
    ai[i] = m / g;
  }
  fftInPlace(ar, ai, true);
  const maxLag = Math.min(Math.round(maxLagSec * rate), a.length - 1);
  const at = (lag) => ar[(lag + n) % n];
  let best = 0;
  let peak = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    if (at(lag) > peak) { peak = at(lag); best = lag; }
  }
  let other = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - best) < rate) continue;
    other = Math.max(other, Math.abs(at(lag)));
  }
  // 無音の枠だと突き合わせの結果が全部 0 になる。山が無いので、一致していない扱いにする。
  return { lag: best / rate, ratio: peak > 0 && other > 0 ? peak / other : 0 };
}

// 枠どうしのずれ edges = [{ i, j, lag }](j は i より lag 秒遅れ)から、枠ごとの遅れを出す。
// つながっている枠がいちばん多い組だけを対象にし、その組の中での遅れ(秒。基準は組の1枠目)を返す。
// 組に入らない枠は null。2 枠以上の組が無ければ null。
function syncOffsets(n, edges) {
  let best = null;
  let bestCount = 1;
  const seen = new Array(n).fill(false);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const off = new Array(n).fill(null);
    off[s] = 0;
    const queue = [s];
    let count = 0;
    while (queue.length) {
      const u = queue.shift();
      seen[u] = true;
      count++;
      for (const e of edges) {
        const v = e.i === u ? e.j : e.j === u ? e.i : -1;
        if (v < 0 || off[v] !== null) continue;
        off[v] = off[u] + (e.i === u ? e.lag : -e.lag);
        queue.push(v);
      }
    }
    if (count > bestCount) { bestCount = count; best = off; }
  }
  return best;
}

// 今の遅延 cur と、その状態で測った遅れ off から、全枠をいちばん遅れている枠に揃える遅延を出す。
// 揃えたうえで全体を前へ詰める(いちばん小さい遅延が 0 になるように)。off が null の枠は null。
// 定期的な合わせ直し用。syncDelays と違い、いちばん遅い枠を 0 に据え直さない。
// 測るたびに対象の顔ぶれが変わりうる(広告中の枠はその回だけ外れる)ので、毎回 0 を据え直すと
// 全枠がまとめて飛ぶことがある。代わりに「どれか 1 枠に揃える」案を全部試し、動かす枠が
// いちばん少ない案を選ぶ(ずれた枠だけが動く)。同数なら、遅延の合計が小さい案にする
// (逆を選ぶと、合わせ直すたびに全体の遅延が少しずつ積み上がる。実際に起きた)。
// 動かす量が minStep 未満の枠はそのまま。遅延は負にできないので、足りなければ全体を後ろへずらす。
function syncAdjust(cur, off, max, minStep) {
  let best = null;
  let bestMoved = Infinity;
  let bestSum = Infinity;
  for (let k = 0; k < off.length; k++) {
    if (off[k] === null) continue;
    const raw = cur.map((c, i) => (off[i] === null ? null : c + off[k] - off[i]));
    const lift = Math.max(0, -Math.min(...raw.filter((v) => v !== null)));
    let moved = 0;
    let sum = 0;
    const next = raw.map((v, i) => {
      if (v === null) return null;
      const d = Math.abs(v + lift - cur[i]) < minStep ? cur[i] : Math.min(max, v + lift);
      if (d !== cur[i]) moved++;
      sum += d;
      return d;
    });
    if (moved < bestMoved || (moved === bestMoved && sum < bestSum)) {
      best = next;
      bestMoved = moved;
      bestSum = sum;
    }
  }
  return best;
}

function syncDelays(cur, off, max) {
  const latest = Math.max(...off.filter((o) => o !== null));
  const next = cur.map((c, i) => (off[i] === null ? null : c + latest - off[i]));
  const min = Math.min(...next.filter((v) => v !== null));
  return next.map((v) => (v === null ? null : Math.min(max, v - min)));
}

// メニューの「音で合わせる」の右に経過や結果を出す。結果(final)は、しばらくしたら消す
// (出しっぱなしだと、いつの結果なのか分からなくなる)。
function setSyncStatus(text, final) {
  const el = document.getElementById('mm-sync-val');
  if (!el) return;
  clearTimeout(syncStatusTimer);
  el.textContent = text;
  if (final || syncRun) document.getElementById('sync-dialog-status').textContent = text;
  if (final) syncStatusTimer = setTimeout(() => { el.textContent = syncIdleStatus(); }, SYNC_STATUS_MS);
}

// 何も実行していないときの表示。定期実行がオンなら、それだけは出しておく。
function syncIdleStatus() {
  return syncAuto ? '自動・残り ' + syncAutoLeft + ' 回' : '';
}

// 定期実行のオン/オフ。オンにしても今すぐは測らず、次の周期から始める(今すぐは OK の役目)。
// オンにするたびに、残り回数を数え直す。
function setSyncAuto(on) {
  syncAuto = on;
  syncAutoLeft = on ? SYNC_AUTO_MAX_RUNS : 0;
  // メニューの切り替えボタンと、ダイアログのチェック(開いていれば)を合わせる。
  const btn = document.getElementById('mm-sync-auto');
  if (btn) btn.classList.toggle('on', on);
  if (!syncRun) setSyncStatus(syncIdleStatus());
  syncDialogUI();
  scheduleAutoSync();
}

// 定期実行を 1 回ぶん数える(枠が足りず測らなかった回も数える。必ず止まるように)。
// 回数を使い切ったらオフにする。
function countAutoSync() {
  syncAutoLeft--;
  if (syncAutoLeft <= 0) setSyncAuto(false);
  else if (!syncRun) setSyncStatus(syncIdleStatus());
}

function scheduleAutoSync() {
  clearTimeout(syncAutoTimer);
  if (syncAuto) syncAutoTimer = setTimeout(() => startAudioSync(true), SYNC_AUTO_GAP_MS);
}

function syncTargets() {
  // 音量 0(ミュート)の枠は聞いていない枠なので合わせない。音を出している枠だけで揃えたあと、
  // 関係ない配信を音を消して並べておけるように。
  return wins.filter((w) => !w.hidden && w.frame && delaySupported(w) && w.vol !== 0);
}

// ダイアログの表示を今の状態に合わせる。定期実行は単独で使うものではないので、
// 一度実行した後か、既にオンのときだけ案内を出す。
function syncDialogUI() {
  const run = document.getElementById('sync-dialog-run');
  if (!run) return;
  run.disabled = syncTargets().length < 2 || !!syncRun;
  document.getElementById('sync-auto-section').hidden = !(syncDialogRan || syncAuto);
  const auto = document.getElementById('sync-dialog-auto');
  auto.textContent = syncAuto ? '定期実行をオフにする' : '定期実行をオンにする';
  auto.classList.toggle('on', syncAuto);
}

// めったに使わない機能なので、押してすぐ動かさず、何をするものかを見せてから実行する。
function openSyncDialog() {
  toggleDialog('sync-dialog', {
    beforeOpen: () => {
      syncDialogRan = false;
      document.getElementById('sync-dialog-status').textContent = syncTargets().length < 2
        ? '音を出している Twitch のライブ枠が 2 つ以上あるときに使えます(音量 0 の枠は対象外)。'
        : syncRun ? 'いま測っている最中です。' : '';
      syncDialogUI();
    }
  });
}

function setupSyncDialog() {
  setupDialog('sync-dialog');
  // 実行しても閉じない(結果と、定期実行の案内を下に出す)。
  document.getElementById('sync-dialog-run').addEventListener('click', () => {
    syncDialogRan = true;
    startAudioSync(false);
    syncDialogUI();
  });
  document.getElementById('sync-dialog-auto').addEventListener('click', () => setSyncAuto(!syncAuto));
}

function postSyncListen(win, on) {
  postToFrame(win.frame, { type: 'sync-listen', value: on });
}

// auto = 定期実行。枠の上の表示もメニューの経過も出さず、静かに測って必要なぶんだけ直す。
function startAudioSync(auto) {
  if (syncRun) return; // 聞いている最中(定期実行と手動が重なったら、先に始めたほうに任せる)
  const targets = syncTargets();
  if (targets.length < 2) { // 手動はダイアログ側で押せなくしてある。定期実行は次の周期を待つ
    if (auto) countAutoSync();
    scheduleAutoSync();
    return;
  }
  clearTimeout(syncAutoTimer); // 次の周期は、測り終えてから数え直す
  syncRun = {
    auto,
    caps: new Map(targets.map((w) => [w, { anchor: Infinity, ts0: null, rate: 0, chunks: [], error: false }])),
    held: new Map(targets.map((w) => [w, w.delayHold])) // 合わせなかった枠を元へ戻すために覚えておく
  };
  if (!auto) setSyncStatus('聞いています…');
  syncDialogUI();
  targets.forEach((w) => {
    // 聞く前に全枠の再生位置を固定する。追いつき(1.03倍)の最中の枠があると、聞いている間にも
    // ずれが動いて山がぼやける(一致の強さが 1/5 以下に落ちた。実測)。
    w.delayHold = true;
    syncFrameDelay(w);
    if (!auto) openSyncView(w);
    postSyncListen(w, true);
  });
  setTimeout(finishAudioSync, SYNC_LISTEN_MS);
}

// 枠から届いた音(twitch-keepalive.js の 5)を溜める。
function onSyncAudio(win, d) {
  const cap = syncRun && syncRun.caps.get(win);
  if (!cap) return;
  if (d.error || !(d.pcm instanceof Float32Array) || !Number.isFinite(d.ts) || !Number.isFinite(d.anchor) || !(d.rate > 0)) {
    cap.error = true;
    return;
  }
  cap.anchor = Math.min(cap.anchor, d.anchor); // 後から届いた値ほど正確(枠側のコメント参照)
  if (cap.ts0 === null) cap.ts0 = d.ts;
  cap.rate = d.rate;
  cap.chunks.push(d.pcm);
  feedSyncView(win, d.pcm, d.rate);
}

// 録音から、枠ごとの遅れを測る。戻り値は { recs, cut, rate, len, off }。
// off は syncOffsets の結果(同じ音の組が無ければ null)。録音が足りなければ null を返す。
function measureAudioSync(caps) {
  const usable = caps.filter(([, c]) => !c.error && c.chunks.length > 0);
  const rate = usable.length ? usable[0][1].rate : 0;
  const recs = usable.filter(([, c]) => c.rate === rate).map(([win, c]) => {
    const pcm = new Float32Array(c.chunks.reduce((sum, x) => sum + x.length, 0));
    let o = 0;
    for (const x of c.chunks) { pcm.set(x, o); o += x.length; }
    return { win, pcm, start: c.anchor + c.ts0 }; // 1 サンプル目の時刻(ms)
  });
  // 全枠の録音が重なっている区間だけを使う。
  const from = Math.max(...recs.map((r) => r.start));
  const to = Math.min(...recs.map((r) => r.start + (r.pcm.length / rate) * 1000));
  const len = Math.floor(((to - from) / 1000) * rate);
  if (recs.length < 2 || !(len >= SYNC_MIN_SEC * rate)) return null;
  const cut = recs.map((r) => {
    const o = Math.round(((from - r.start) / 1000) * rate);
    return r.pcm.subarray(o, o + len);
  });
  const edges = [];
  for (let i = 0; i < cut.length; i++) {
    for (let j = i + 1; j < cut.length; j++) {
      const m = audioLag(cut[i], cut[j], rate, SYNC_MAX_LAG_SEC);
      if (m.ratio >= SYNC_MIN_RATIO) edges.push({ i, j, lag: m.lag });
    }
  }
  return { recs, cut, rate, len, off: syncOffsets(cut.length, edges) };
}

function finishAudioSync() {
  const run = syncRun;
  syncRun = null;
  if (!run) return;
  const caps = [...run.caps].filter(([w]) => wins.includes(w)); // 聞いている間に閉じた枠は外す
  caps.forEach(([w]) => postSyncListen(w, false));
  const m = measureAudioSync(caps);
  if (run.auto) {
    finishAutoSync(run, caps, m);
    countAutoSync();
    document.getElementById('sync-dialog-status').textContent = '';
  } else {
    finishManualSync(run, caps, m);
  }
  syncDialogUI();
  scheduleAutoSync();
}

// 合わせなかった枠は、位置の固定を聞く前の状態へ戻す。
function releaseSyncHold(run, win) {
  win.delayHold = !!run.held.get(win);
  syncFrameDelay(win);
  if (win.syncDelayUI) win.syncDelayUI();
}

function finishManualSync(run, caps, m) {
  if (!m || !m.off) {
    const text = m ? '同じ音が見つかりません' : '音を取り出せませんでした';
    setSyncStatus(text, true);
    caps.forEach(([w]) => { releaseSyncHold(run, w); endSyncView(w, text, null); });
    return;
  }
  const { recs, cut, rate, len, off } = m;
  const next = syncDelays(recs.map((r) => r.win.delay), off, DELAY_MAX_SEC);
  // 枠の上の表示用。基準(いちばん遅れている枠)の波形に、各枠の波形がずれた位置から重なっていく。
  const latest = Math.max(...off.filter((o) => o !== null));
  const refEnv = audioEnvelope(cut[off.indexOf(latest)], rate, SYNC_ENV_HZ);
  const viewFrom = Math.max(0, (len / rate - SYNC_VIEW_SEC) / 2); // 録音のまんなかあたりを見せる
  let done = 0;
  next.forEach((v, i) => {
    const win = recs[i].win;
    if (v === null) {
      releaseSyncHold(run, win);
      endSyncView(win, '同じ音が見つかりません', null);
      return;
    }
    setWinDelay(win, v); // 固定(delayHold)は付けたまま。遅延 0 の基準の枠も動かないようにする
    done++;
    const text = win.delay >= DELAY_MAX_SEC
      ? '+' + win.delay.toFixed(2) + ' 秒(上限。合わせきれません)'
      : win.delay > 0 ? '+' + win.delay.toFixed(2) + ' 秒' : 'そのまま(いちばん遅い枠)';
    endSyncView(win, text, {
      own: audioEnvelope(cut[i], rate, SYNC_ENV_HZ), ref: refEnv, shift: latest - off[i], from: viewFrom
    });
  });
  // 録音が使えなかった枠(recs に入らなかった枠)の表示も締める。
  caps.forEach(([w]) => {
    if (recs.some((r) => r.win === w)) return;
    releaseSyncHold(run, w);
    endSyncView(w, '音を取り出せませんでした', null);
  });
  setSyncStatus(done + ' 枠を合わせました', true);
}

// 定期実行の締め。合った枠だけを、必要なぶんだけ動かす。
// その回に合わなかった枠は、遅延には触らない(広告中や無音の間だけ外れた枠を、合わせた位置から
// 動かさないため)。位置の固定だけ、聞く前の状態へ戻す(元から固定していた枠は固定のまま)。
function finishAutoSync(run, caps, m) {
  const matched = new Set();
  if (m && m.off) {
    const next = syncAdjust(m.recs.map((r) => r.win.delay), m.off, DELAY_MAX_SEC, SYNC_AUTO_MIN_STEP);
    next.forEach((v, i) => {
      if (v === null) return;
      const win = m.recs[i].win;
      matched.add(win);
      if (v !== win.delay) setWinDelay(win, v);
    });
  }
  caps.forEach(([w]) => { if (!matched.has(w)) releaseSyncHold(run, w); });
}

// ====== 音で合わせる: 枠の上の表示 ======
// 何が起きているかを枠の上に出す。聞いている間は、その枠から取れている音の波形が流れる。
// 測り終えたら、基準の枠の波形(灰色)の上に、その枠の波形がずれた位置から滑ってきて重なる。
// 押してから結果が出るまで 20 秒あるので、動いていることと、どの枠をどれだけ動かしたかを見せる。
const SYNC_VIEW_SEC = 6;    // 波形として見せる時間幅
const SYNC_ENV_HZ = 50;     // 波形の細かさ(1 秒あたりの点数)
const SYNC_SLIDE_MS = 1800; // 波形が重なるまでの時間
const SYNC_HOLD_MS = 3500;  // 結果を出したままにしておく時間
const SYNC_FADE_MS = 500;   // CSS の .win-sync の transition と合わせる
let syncViewRaf = 0;

// 音を、hz 点/秒の「その区間でいちばん大きい振れ」の列に縮める(波形の描画用)。
function audioEnvelope(pcm, rate, hz) {
  const step = rate / hz;
  const out = new Float32Array(Math.floor(pcm.length / step));
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    const end = Math.floor((i + 1) * step);
    for (let j = Math.floor(i * step); j < end; j++) m = Math.max(m, Math.abs(pcm[j]));
    out[i] = m;
  }
  return out;
}

function openSyncView(win) {
  closeSyncView(win);
  const el = document.createElement('div');
  el.className = 'win-sync listen';
  el.style.setProperty('--sync-ms', SYNC_LISTEN_MS + 'ms');
  const canvas = document.createElement('canvas');
  const label = document.createElement('div');
  label.className = 'win-sync-label';
  label.textContent = '聞いています…';
  const bar = document.createElement('div');
  bar.className = 'win-sync-bar';
  el.append(canvas, label, bar);
  (win.mediaEl || win.body).appendChild(el);
  // env = 聞いている間に届いた波形(届くたびに後ろへ足す)。slide = 結果の表示用データ。
  win.syncView = { el, canvas, label, env: [], batchSec: 0, batchAt: 0, slide: null, slideAt: 0 };
  if (!syncViewRaf) syncViewRaf = requestAnimationFrame(drawSyncViews);
}

function feedSyncView(win, pcm, rate) {
  const v = win.syncView;
  if (!v) return;
  for (const x of audioEnvelope(pcm, rate, SYNC_ENV_HZ)) v.env.push(x);
  v.batchSec = pcm.length / rate;
  v.batchAt = performance.now();
}

// 結果を出して、しばらくしてから消す。slide が null なら文言だけ(波形はその場で止まる)。
function endSyncView(win, text, slide) {
  const v = win.syncView;
  if (!v) return;
  v.el.classList.remove('listen');
  v.el.classList.toggle('matched', !!slide);
  v.label.textContent = text;
  v.slide = slide;
  v.slideAt = performance.now();
  setTimeout(() => { if (win.syncView === v) closeSyncView(win); }, (slide ? SYNC_SLIDE_MS : 0) + SYNC_HOLD_MS);
}

function closeSyncView(win) {
  const v = win.syncView;
  if (!v) return;
  win.syncView = null;
  v.el.classList.add('out');
  setTimeout(() => v.el.remove(), SYNC_FADE_MS);
}

// env を、時刻 from(秒)が左端になるように描く。shift 秒だけ右へずらす。上下対称の棒で波形に見せる。
// canvas には CSS の var() を渡せないので、:root の値を読む。
const themeColors = new Map();
function themeColor(name) {
  if (!themeColors.has(name)) {
    themeColors.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }
  return themeColors.get(name);
}

function drawSyncWave(g, env, from, shift, pps, h, color) {
  let peak = 1e-4;
  for (const x of env) peak = Math.max(peak, x);
  const bw = Math.max(1, pps / SYNC_ENV_HZ - 1);
  g.fillStyle = color;
  for (let k = 0; k < env.length; k++) {
    const x = (k / SYNC_ENV_HZ + shift - from) * pps;
    if (x < -bw || x > g.canvas.width) continue;
    const half = Math.max(1, (env[k] / peak) * h * 0.46);
    g.fillRect(x, h / 2 - half, bw, half * 2);
  }
}

function drawSyncViews() {
  syncViewRaf = 0;
  const now = performance.now();
  let alive = false;
  for (const win of wins) {
    const v = win.syncView;
    if (!v) continue;
    alive = true;
    const c = v.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (!w || !h) continue;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const pps = w / SYNC_VIEW_SEC;
    if (v.slide) {
      const p = Math.min(1, (now - v.slideAt) / SYNC_SLIDE_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      drawSyncWave(g, v.slide.ref, v.slide.from, 0, pps, h, 'rgba(255,255,255,0.32)');
      drawSyncWave(g, v.slide.own, v.slide.from, v.slide.shift * eased, pps, h, themeColor(p >= 1 ? '--c-success' : '--c-accent'));
    } else {
      // 音は 0.5 秒ごとにまとめて届く。届いた分を一度に出すとカクつくので、1 回分だけ遅らせて
      // 右端を時間で進め、なめらかに流れて見えるようにする。
      const shown = v.el.classList.contains('listen') ? Math.min(v.batchSec, (now - v.batchAt) / 1000) : v.batchSec;
      const right = v.env.length / SYNC_ENV_HZ - v.batchSec + shown;
      drawSyncWave(g, v.env, right - SYNC_VIEW_SEC, 0, pps, h, v.el.classList.contains('listen') ? themeColor('--c-accent') : 'rgba(255,255,255,0.4)');
    }
  }
  if (alive) syncViewRaf = requestAnimationFrame(drawSyncViews);
}
