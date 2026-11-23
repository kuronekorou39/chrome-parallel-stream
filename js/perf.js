// パフォーマンスパネル。

// パフォーマンス計測パネル(📊)。FPS(このページの描画)・システムCPU%・システムメモリ%・
// JSヒープ・枠数を 1秒ごとに更新し、各値のスパークライン(直近 PERF_HISTORY 秒)を描く。
// パネルが開いている間だけ計測する(閉じれば rAF も interval も止めて負荷ゼロ)。
function setupPerfPanel() {
  const panel = document.getElementById('perf-panel');
  const rowsEl = panel.querySelector('.perf-rows');
  const btn = document.getElementById('perf-btn');
  // ヘッダをつかんで移動できるようにする(ミキサーと同じ仕組み。閉じる✕の上では動かない)。
  makePanelDraggable(panel, panel.querySelector('.perf-head'));
  wirePanelRaise(panel); // 掴む/フォーカスで最前面へ

  const hist = { fps: [], cpu: [], mem: [], heap: [] };
  const ui = {};
  [['fps', 'FPS'], ['cpu', 'CPU'], ['mem', 'MEM'], ['heap', 'JS']].forEach(([key, label]) => {
    const row = document.createElement('div'); row.className = 'perf-row';
    const lab = document.createElement('span'); lab.className = 'perf-label'; lab.textContent = label;
    const val = document.createElement('span'); val.className = 'perf-val'; val.textContent = '–';
    const cv = document.createElement('canvas'); cv.className = 'perf-spark'; cv.width = 100; cv.height = 24;
    row.append(lab, val, cv);
    rowsEl.appendChild(row);
    ui[key] = { row, val, canvas: cv };
  });
  // 枠数(スパークラインなし)
  const cRow = document.createElement('div'); cRow.className = 'perf-row';
  const cLab = document.createElement('span'); cLab.className = 'perf-label'; cLab.textContent = '枠';
  const cVal = document.createElement('span'); cVal.className = 'perf-val'; cVal.textContent = '0';
  cRow.append(cLab, cVal); rowsEl.appendChild(cRow);

  const push = (k, v) => { const a = hist[k]; a.push(v); if (a.length > PERF_HISTORY) a.shift(); };
  const drawSpark = (cv, data, max, color, warn) => {
    const ctx = cv.getContext('2d'); const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    if (data.length < 2 || !max) return;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (PERF_HISTORY - 1)) * w;
      const y = h - 1 - Math.max(0, Math.min(v, max)) / max * (h - 2);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = themeColor(warn ? '--c-danger' : color); ctx.lineWidth = 1.5; ctx.stroke();
  };

  let frames = 0, rafId = null, tickId = null, prevCpu = null;
  const onFrame = () => { frames++; rafId = requestAnimationFrame(onFrame); };

  const sample = async () => {
    const fps = frames; frames = 0; push('fps', fps);

    let cpu = 0;
    try {
      const info = await MV.system.cpu.getInfo();
      let user = 0, kernel = 0, total = 0;
      for (const p of info.processors) { user += p.usage.user; kernel += p.usage.kernel; total += p.usage.total; }
      if (prevCpu) {
        const dB = (user - prevCpu.user) + (kernel - prevCpu.kernel);
        const dT = total - prevCpu.total;
        cpu = dT > 0 ? Math.round((dB / dT) * 100) : 0;
      }
      prevCpu = { user, kernel, total };
    } catch (e) { /* noop */ }
    push('cpu', cpu);

    let mem = 0, memTitle = '';
    try {
      const m = await MV.system.memory.getInfo();
      mem = Math.round((1 - m.availableCapacity / m.capacity) * 100);
      const usedGB = (m.capacity - m.availableCapacity) / 1073741824;
      const totGB = m.capacity / 1073741824;
      memTitle = '使用 ' + usedGB.toFixed(1) + ' / ' + totGB.toFixed(1) + ' GB';
    } catch (e) { /* noop */ }
    push('mem', mem);

    let heap = 0, heapMax = 0;
    if (performance.memory) {
      heap = Math.round(performance.memory.usedJSHeapSize / 1048576);
      heapMax = performance.memory.jsHeapSizeLimit / 1048576;
    }
    push('heap', heap);

    ui.fps.val.textContent = fps;
    ui.cpu.val.textContent = cpu + '%';
    ui.mem.val.textContent = mem + '%';
    ui.mem.row.title = memTitle;
    ui.heap.val.textContent = performance.memory ? heap + 'MB' : 'N/A';
    cVal.textContent = String(wins.length);

    ui.fps.val.classList.toggle('warn', fps < 30);
    ui.cpu.val.classList.toggle('warn', cpu > 85);
    ui.mem.val.classList.toggle('warn', mem > 90);

    drawSpark(ui.fps.canvas, hist.fps, 60, '--c-success', fps < 30);
    drawSpark(ui.cpu.canvas, hist.cpu, 100, '--c-accent', cpu > 85);
    drawSpark(ui.mem.canvas, hist.mem, 100, '--c-warning', mem > 90);
    drawSpark(ui.heap.canvas, hist.heap, heapMax || Math.max(1, ...hist.heap), '--c-purple', false);
  };

  const start = () => {
    if (tickId) return;
    frames = 0; prevCpu = null;
    onFrame();
    tickId = setInterval(sample, 1000);
    sample();
  };
  const stop = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (tickId) { clearInterval(tickId); tickId = null; }
  };
  const toggle = () => {
    if (panel.hasAttribute('hidden')) {
      panel.removeAttribute('hidden'); btn.classList.add('on-blue'); raisePanel(panel); centerPanel(panel); start(); // 開いたら最前面+中央
    } else {
      panel.setAttribute('hidden', ''); btn.classList.remove('on-blue'); stop();
    }
  };
  btn.addEventListener('click', toggle);
  document.getElementById('perf-close').addEventListener('click', toggle);
}
