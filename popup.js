// popup の描画とアクション。
// background.js に問い合わせて report を取得し、各セクションに流し込む。

const STORAGE_KEY = 'probeReport';

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
    // フォールバック: textarea + execCommand
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

// ---------- レンダリング ----------

function render(report) {
  if (!report) {
    setStatus('No report yet. Click "Re-run probes".', 'info');
    renderEmptyAll();
    return;
  }
  setStatus(`Last run: ${report.timestamp || 'unknown'}`);

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
  const blocks = customs.map((ns) => {
    const detail = surface.detail[ns];
    return apiBlockHtml(ns, detail, /*isCustom*/ true);
  });
  target.innerHTML = blocks.join('');
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
  const blocks = standards.map((ns) =>
    apiBlockHtml(ns, surface.detail[ns], /*isCustom*/ false)
  );
  target.innerHTML = blocks.join('');
}

function apiBlockHtml(ns, detail, isCustom) {
  if (!detail) return '';
  const marker = isCustom
    ? '<span class="custom-marker">★ CUSTOM</span> '
    : '';
  const nameCls = isCustom ? 'api-name' : 'api-name standard';
  let html = `<div class="api-block">${marker}<span class="${nameCls}">chrome.${escapeHtml(
    ns
  )}</span> <span class="api-typeof">[${escapeHtml(detail.typeof)}]</span>`;
  const members = detail.members || [];
  for (const m of members) {
    html += `<div class="member"><span class="name">${escapeHtml(
      m.name
    )}</span> <span class="api-typeof">[${escapeHtml(m.typeof)}]</span></div>`;
    if (m.subMembers && m.subMembers.length) {
      for (const sm of m.subMembers) {
        html += `<div class="sub-member">${escapeHtml(
          sm.name
        )} [${escapeHtml(sm.typeof)}]</div>`;
      }
    }
  }
  if (detail.error) {
    html += `<div class="member"><span class="tag tag-err">err</span> ${escapeHtml(
      detail.error
    )}</div>`;
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
    html += `<div class="api-block"><div><span class="api-name">type:</span> ${escapeHtml(
      t.type
    )}`;
    if (t.createError) {
      html += ` <span class="tag tag-err">create failed</span>`;
    } else if (t.createResult) {
      html += ` <span class="tag tag-ok">created</span>`;
    }
    html += `</div><pre class="json">${escapeHtml(
      JSON.stringify(t, null, 2)
    )}</pre></div>`;
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
  target.innerHTML = `<pre class="json">${escapeHtml(
    JSON.stringify(probe, null, 2)
  )}</pre>`;
}

function renderWebviewProbe(report) {
  const probe = report.webviewProbe;
  const target = $('webview-probe');
  if (!probe) {
    target.innerHTML = '<span class="empty">webview probe did not run</span>';
    return;
  }
  target.innerHTML = `<pre class="json">${escapeHtml(
    JSON.stringify(probe, null, 2)
  )}</pre>`;
}

function renderErrors(report) {
  const target = $('errors');
  const errs = report.errors || {};
  const keys = Object.keys(errs);
  if (keys.length === 0) {
    target.innerHTML = '<span class="empty">no errors</span>';
    return;
  }
  target.innerHTML = `<pre class="json">${escapeHtml(
    JSON.stringify(errs, null, 2)
  )}</pre>`;
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

// ---------- Markdown 変換（Claudeに貼り戻す用） ----------

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

  // Custom APIs
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

  // Standard APIs
  L.push('## Standard APIs (reference)');
  const stds = surface.standardNamespaces || [];
  L.push(stds.length ? stds.map((s) => `\`${s}\``).join(', ') : '_None._');
  L.push('');

  // Windows
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

  // Fullscreen
  L.push('## Fullscreen Probe');
  if (report.fullscreenProbe) {
    L.push('```json');
    L.push(JSON.stringify(report.fullscreenProbe, null, 2));
    L.push('```');
  } else {
    L.push('_No data._');
  }
  L.push('');

  // Webview
  L.push('## Webview / Custom Namespace Probe');
  if (report.webviewProbe) {
    L.push('```json');
    L.push(JSON.stringify(report.webviewProbe, null, 2));
    L.push('```');
  } else {
    L.push('_No data._');
  }
  L.push('');

  // Errors
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
  $('rerun').addEventListener('click', rerun);
  $('copy-json').addEventListener('click', copyJson);
  $('copy-md').addEventListener('click', copyMarkdown);

  const report = await loadReport();
  render(report);
});
