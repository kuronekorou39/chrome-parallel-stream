// popup の描画とアクション。
// 2タブ構成: Multiview (本機能) / Probe (Phase 1のケイパビリティ調査結果)

const STORAGE_KEY = 'probeReport';
const MULTIVIEW_PREFS_KEY = 'multiviewPrefs';
const MULTIVIEW_LAST_KEY = 'multiviewLastRun';

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

// ---------- タブ切替 ----------

function activateTab(name) {
  document
    .querySelectorAll('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document
    .querySelectorAll('.panel')
    .forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
}

// ---------- Multiview ----------

let saveDebounceTimer = null;
function scheduleSavePrefs() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(saveMultiviewPrefs, 400);
}

async function saveMultiviewPrefs() {
  const urls = Array.from(document.querySelectorAll('.url-input')).map((i) => i.value);
  const layoutRadio = document.querySelector('input[name="layout"]:checked');
  const layout = layoutRadio ? layoutRadio.value : 'auto';
  await chrome.storage.local.set({ [MULTIVIEW_PREFS_KEY]: { urls, layout } });
}

async function loadMultiviewPrefs() {
  const data = await chrome.storage.local.get(MULTIVIEW_PREFS_KEY);
  const prefs = data[MULTIVIEW_PREFS_KEY] || {};
  const urls = prefs.urls || [];
  document.querySelectorAll('.url-input').forEach((input, i) => {
    input.value = urls[i] || '';
  });
  const layout = prefs.layout || 'auto';
  const r = document.querySelector('input[name="layout"][value="' + layout + '"]');
  if (r) r.checked = true;
}

async function openMultiview() {
  const urls = Array.from(document.querySelectorAll('.url-input'))
    .map((i) => i.value.trim())
    .filter((u) => u.length > 0);

  if (urls.length === 0) {
    setStatus('No URLs entered.', 'error');
    return;
  }

  const layoutRadio = document.querySelector('input[name="layout"]:checked');
  const layout = layoutRadio ? layoutRadio.value : 'auto';

  const screenSize = {
    availLeft: window.screen.availLeft || 0,
    availTop: window.screen.availTop || 0,
    availWidth: window.screen.availWidth,
    availHeight: window.screen.availHeight
  };
  const rects = window.MultiviewLayout.compute(urls.length, layout, screenSize);

  setStatus('Opening ' + urls.length + ' streams…', 'info');
  $('open-multiview').disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'open-multiview',
      urls,
      layouts: rects,
      layout
    });
    if (resp && resp.ok) {
      const failCount = (resp.failures || []).length;
      setStatus(
        'Opened ' +
          (resp.windowIds || []).length +
          ' windows' +
          (failCount ? ', ' + failCount + ' failed' : '') +
          '. シアターモード適用中… (結果は再度ポップアップを開くと表示)',
        failCount ? 'info' : 'success'
      );
      renderLastRun({
        timestamp: new Date().toISOString(),
        urls,
        layout,
        windowIds: resp.windowIds,
        failures: resp.failures
      });
    } else {
      setStatus('Open failed: ' + JSON.stringify(resp && resp.error), 'error');
    }
  } catch (e) {
    setStatus('Open error: ' + e.message, 'error');
  } finally {
    $('open-multiview').disabled = false;
  }
}

async function closeMultiview() {
  setStatus('Closing opened windows…', 'info');
  $('close-multiview').disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'close-multiview' });
    if (resp && resp.ok) {
      setStatus('Closed ' + (resp.closed || []).length + ' windows.', 'success');
    } else {
      setStatus('Close failed: ' + JSON.stringify(resp && resp.error), 'error');
    }
  } catch (e) {
    setStatus('Close error: ' + e.message, 'error');
  } finally {
    $('close-multiview').disabled = false;
  }
}

function renderLastRun(run) {
  if (!run) {
    $('multiview-last').innerHTML = '<span class="empty">no runs yet</span>';
    return;
  }
  const html = [];
  html.push('<div class="kv">');
  html.push('<div class="k">timestamp</div><div class="v">' + escapeHtml(run.timestamp) + '</div>');
  html.push('<div class="k">layout</div><div class="v">' + escapeHtml(run.layout || '') + '</div>');
  html.push(
    '<div class="k">windowIds</div><div class="v">' +
      escapeHtml((run.windowIds || []).join(', ')) +
      '</div>'
  );
  html.push('</div>');
  for (const u of run.urls || []) {
    html.push('<div class="member">• ' + escapeHtml(u) + '</div>');
  }
  // open に失敗した URL
  for (const f of run.failures || []) {
    const msg = f.error && f.error.message ? ' — ' + f.error.message : '';
    html.push(
      '<div class="member"><span class="tag tag-err">open失敗</span> ' +
        escapeHtml(f.url) +
        escapeHtml(msg) +
        '</div>'
    );
  }
  // シアターモード自動ON(inject)結果
  html.push('<div class="inject-head">シアターモード自動ON結果</div>');
  const injects = run.injectResults || [];
  if (injects.length === 0) {
    html.push(
      '<div class="member"><span class="empty">まだ結果がありません(ページ読込待ち)</span></div>'
    );
  } else {
    for (const r of injects) {
      html.push(injectResultHtml(r));
    }
  }
  $('multiview-last').innerHTML = html.join('');
}

function injectResultHtml(r) {
  const res = (r && r.result) || {};
  let tag;
  if (r && r.error) {
    tag = '<span class="tag tag-err">inject失敗</span>';
  } else if (res.succeeded) {
    tag = '<span class="tag tag-ok">ON</span>';
  } else if (res.skipped) {
    tag = '<span class="tag tag-skip">対象外</span>';
  } else {
    tag = '<span class="tag tag-skip">未ON</span>';
  }
  const host = res.hostname || (r && r.url) || '';
  const via = res.succeededVia
    ? ' <span class="hint">' + escapeHtml(res.succeededVia) + '</span>'
    : '';
  let detail = '';
  if (r && r.error) {
    detail = ' — ' + (r.error.message || JSON.stringify(r.error));
  } else if (res.reason) {
    detail = ' — ' + res.reason;
  }
  return (
    '<div class="member">' + tag + ' ' + escapeHtml(host) + via + escapeHtml(detail) + '</div>'
  );
}

async function loadLastRun() {
  const data = await chrome.storage.local.get(MULTIVIEW_LAST_KEY);
  if (data[MULTIVIEW_LAST_KEY]) renderLastRun(data[MULTIVIEW_LAST_KEY]);
}

// ---------- Probe ----------

async function loadReport() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || null;
}

async function rerun() {
  setStatus('Running probes…', 'info');
  $('rerun').disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'rerun-probes' });
    if (resp && resp.ok) {
      render(resp.report);
      setStatus('Probes completed.', 'success');
    } else {
      setStatus('Probe run failed.', 'error');
      console.error(resp);
    }
  } catch (e) {
    setStatus('Probe run error: ' + e.message, 'error');
    console.error(e);
  } finally {
    $('rerun').disabled = false;
  }
}

async function copyJson() {
  const report = await loadReport();
  const text = JSON.stringify(report, null, 2);
  await copyToClipboard(text);
  setStatus('Copied JSON to clipboard.', 'success');
}

async function copyMarkdown() {
  const report = await loadReport();
  const md = reportToMarkdown(report);
  await copyToClipboard(md);
  setStatus('Copied Markdown to clipboard.', 'success');
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function render(report) {
  if (!report) {
    renderEmptyAll();
    return;
  }
  renderCustomApis(report);
  renderStandardApis(report);
  renderWindowsProbe(report);
  renderFullscreenProbe(report);
  renderWebviewProbe(report);
  renderErrors(report);
  renderMeta(report);
}

function renderEmptyAll() {
  for (const id of [
    'custom-apis',
    'standard-apis',
    'windows-probe',
    'fullscreen-probe',
    'webview-probe',
    'errors',
    'meta'
  ]) {
    $(id).innerHTML = '<span class="empty">no data</span>';
  }
}

function renderCustomApis(report) {
  const surface = report.apiSurface;
  const target = $('custom-apis');
  if (!surface) {
    target.innerHTML = '<span class="empty">apiSurface probe did not run</span>';
    return;
  }
  const customs = surface.customNamespaces || [];
  if (customs.length === 0) {
    target.innerHTML =
      '<span class="empty">標準外の chrome.* namespace は検出されませんでした。</span>';
    return;
  }
  target.innerHTML = customs
    .map((ns) => apiBlockHtml(ns, surface.detail[ns], /*isCustom*/ true))
    .join('');
}

function renderStandardApis(report) {
  const surface = report.apiSurface;
  const target = $('standard-apis');
  if (!surface) {
    target.innerHTML = '<span class="empty">apiSurface probe did not run</span>';
    return;
  }
  const standards = surface.standardNamespaces || [];
  if (standards.length === 0) {
    target.innerHTML = '<span class="empty">none</span>';
    return;
  }
  target.innerHTML = standards
    .map((ns) => apiBlockHtml(ns, surface.detail[ns], /*isCustom*/ false))
    .join('');
}

function apiBlockHtml(ns, detail, isCustom) {
  if (!detail) return '';
  const marker = isCustom ? '<span class="custom-marker">★ CUSTOM</span> ' : '';
  const nameCls = isCustom ? 'api-name' : 'api-name standard';
  let html =
    `<div class="api-block">${marker}<span class="${nameCls}">chrome.${escapeHtml(ns)}</span>` +
    ` <span class="api-typeof">[${escapeHtml(detail.typeof)}]</span>`;
  for (const m of detail.members || []) {
    html +=
      `<div class="member"><span class="name">${escapeHtml(m.name)}</span>` +
      ` <span class="api-typeof">[${escapeHtml(m.typeof)}]</span></div>`;
    for (const sm of m.subMembers || []) {
      html += `<div class="sub-member">${escapeHtml(sm.name)} [${escapeHtml(sm.typeof)}]</div>`;
    }
  }
  if (detail.error) {
    html += `<div class="member"><span class="tag tag-err">err</span> ${escapeHtml(detail.error)}</div>`;
  }
  html += '</div>';
  return html;
}

function renderWindowsProbe(report) {
  const probe = report.windowsProbe;
  const target = $('windows-probe');
  if (!probe) {
    target.innerHTML = '<span class="empty">windows probe did not run</span>';
    return;
  }
  let html = '';
  html += `<div class="kv"><div class="k">available</div><div class="v">${probe.available}</div>`;
  html += `<div class="k">methods</div><div class="v">${escapeHtml(
    (probe.methods || []).join(', ') || '(none)'
  )}</div></div>`;
  for (const t of probe.createTests || []) {
    html += `<div class="api-block"><div><span class="api-name">type:</span> ${escapeHtml(t.type)}`;
    if (t.createError) html += ` <span class="tag tag-err">create failed</span>`;
    else if (t.createResult) html += ` <span class="tag tag-ok">created</span>`;
    html += `</div><pre class="json">${escapeHtml(JSON.stringify(t, null, 2))}</pre></div>`;
  }
  if (probe.notes && probe.notes.length) {
    html += `<div>notes: ${escapeHtml(probe.notes.join(' / '))}</div>`;
  }
  target.innerHTML = html;
}

function renderFullscreenProbe(report) {
  const probe = report.fullscreenProbe;
  const target = $('fullscreen-probe');
  if (!probe) {
    target.innerHTML = '<span class="empty">fullscreen probe did not run</span>';
    return;
  }
  if (probe.skipped) {
    target.innerHTML =
      `<span class="tag tag-skip">skipped</span> ${escapeHtml(probe.reason || '')}` +
      (probe.url ? `<div>url: ${escapeHtml(probe.url)}</div>` : '');
    return;
  }
  target.innerHTML = `<pre class="json">${escapeHtml(JSON.stringify(probe, null, 2))}</pre>`;
}

function renderWebviewProbe(report) {
  const probe = report.webviewProbe;
  const target = $('webview-probe');
  if (!probe) {
    target.innerHTML = '<span class="empty">webview probe did not run</span>';
    return;
  }
  target.innerHTML = `<pre class="json">${escapeHtml(JSON.stringify(probe, null, 2))}</pre>`;
}

function renderErrors(report) {
  const target = $('errors');
  const errs = report.errors || {};
  if (Object.keys(errs).length === 0) {
    target.innerHTML = '<span class="empty">no errors</span>';
    return;
  }
  target.innerHTML = `<pre class="json">${escapeHtml(JSON.stringify(errs, null, 2))}</pre>`;
}

function renderMeta(report) {
  const target = $('meta');
  target.innerHTML = `<div class="kv">
    <div class="k">timestamp</div><div class="v">${escapeHtml(report.timestamp)}</div>
    <div class="k">userAgent</div><div class="v">${escapeHtml(report.userAgent)}</div>
    <div class="k">platform</div><div class="v">${escapeHtml(report.platform)}</div>
    <div class="k">language</div><div class="v">${escapeHtml(report.language)}</div>
  </div>`;
}

function reportToMarkdown(report) {
  if (!report) return '# Parallel Stream Probe Report\n\n_No report yet._\n';

  const L = [];
  L.push('# Parallel Stream Probe Report');
  L.push('');
  L.push(`- timestamp: \`${report.timestamp}\``);
  L.push(`- userAgent: \`${report.userAgent}\``);
  L.push(`- platform: \`${report.platform}\``);
  L.push(`- language: \`${report.language}\``);
  L.push('');

  L.push('## Custom APIs (★)');
  const surface = report.apiSurface || {};
  const customs = surface.customNamespaces || [];
  if (customs.length === 0) {
    L.push('_None detected._');
  } else {
    for (const ns of customs) {
      const d = (surface.detail || {})[ns];
      L.push(`### ★ \`chrome.${ns}\``);
      if (d) {
        L.push(`- typeof: \`${d.typeof}\``);
        for (const m of d.members || []) {
          L.push(`  - \`${m.name}\` (${m.typeof})`);
          for (const sm of m.subMembers || []) {
            L.push(`    - \`${sm.name}\` (${sm.typeof})`);
          }
        }
      }
      L.push('');
    }
  }
  L.push('');

  L.push('## Standard APIs (reference)');
  const stds = surface.standardNamespaces || [];
  L.push(stds.length ? stds.map((s) => `\`${s}\``).join(', ') : '_None._');
  L.push('');

  L.push('## Windows Probe');
  if (report.windowsProbe) {
    L.push(`- available: \`${report.windowsProbe.available}\``);
    L.push(
      `- methods: ${(report.windowsProbe.methods || [])
        .map((m) => `\`${m}\``)
        .join(', ') || '_none_'}`
    );
    for (const t of report.windowsProbe.createTests || []) {
      L.push(`### type: \`${t.type}\``);
      L.push('```json');
      L.push(JSON.stringify(t, null, 2));
      L.push('```');
    }
  } else {
    L.push('_No data._');
  }
  L.push('');

  L.push('## Fullscreen Probe');
  if (report.fullscreenProbe) {
    L.push('```json');
    L.push(JSON.stringify(report.fullscreenProbe, null, 2));
    L.push('```');
  } else {
    L.push('_No data._');
  }
  L.push('');

  L.push('## Webview / Custom Namespace Probe');
  if (report.webviewProbe) {
    L.push('```json');
    L.push(JSON.stringify(report.webviewProbe, null, 2));
    L.push('```');
  } else {
    L.push('_No data._');
  }
  L.push('');

  L.push('## Errors');
  const errs = report.errors || {};
  if (Object.keys(errs).length === 0) {
    L.push('_None._');
  } else {
    L.push('```json');
    L.push(JSON.stringify(errs, null, 2));
    L.push('```');
  }

  return L.join('\n');
}

// ---------- 初期化 ----------

document.addEventListener('DOMContentLoaded', async () => {
  // タブ
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
  });

  // Multiview
  document.querySelectorAll('.url-input').forEach((input) => {
    input.addEventListener('input', scheduleSavePrefs);
    input.addEventListener('change', saveMultiviewPrefs);
  });
  document.querySelectorAll('input[name="layout"]').forEach((r) => {
    r.addEventListener('change', saveMultiviewPrefs);
  });
  $('open-multiview').addEventListener('click', openMultiview);
  $('close-multiview').addEventListener('click', closeMultiview);

  // Probe
  $('rerun').addEventListener('click', rerun);
  $('copy-json').addEventListener('click', copyJson);
  $('copy-md').addEventListener('click', copyMarkdown);

  // 初期データロード
  await loadMultiviewPrefs();
  await loadLastRun();
  const report = await loadReport();
  render(report);
});
