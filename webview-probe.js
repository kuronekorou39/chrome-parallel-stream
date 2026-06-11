// 「あったら嬉しい」独自API名前空間を探索する。
// 命名規則を網羅的に試した上で、chrome.* 全列挙とも突き合わせる。
//
// self.STANDARD_CHROME_EXTENSION_APIS は probes/api-surface.js が登録する想定。
// importScripts の順序は background.js が制御する。

const CANDIDATE_NAMESPACES = [
  ['chrome', 'multiview'],
  ['chrome', 'tile'],
  ['chrome', 'webview'],
  ['chrome', 'layout'],
  ['chrome', 'split'],
  ['chrome', 'splitView'],
  ['chrome', 'splitScreen'],
  ['chrome', 'parallel'],
  ['chrome', 'parallelStream'],
  ['chrome', 'mosaic'],
  ['chrome', 'pip'],
  ['chrome', 'pictureInPicture'],
  ['browser', 'multiview'],
  ['browser', 'tile'],
  ['browser', 'webview']
];

self.runWebviewProbe = async function runWebviewProbe() {
  const result = {
    candidates: [],
    detectedCustomFromChromeKeys: [],
    detectedCustomFromBrowserKeys: [],
    hasBrowserNamespace: typeof browser !== 'undefined',
    notes: []
  };

  // 1. 候補名前空間を1つずつ叩く
  for (const [root, name] of CANDIDATE_NAMESPACES) {
    result.candidates.push(probeNamespace(root, name));
  }

  // 2. chrome.* を全列挙し、標準セットに無いものは全部「独自候補」として記録
  const standardSet = self.STANDARD_CHROME_EXTENSION_APIS;
  if (!standardSet) {
    result.notes.push(
      'self.STANDARD_CHROME_EXTENSION_APIS is not set; api-surface.js may have failed to load first'
    );
  }

  if (typeof chrome !== 'undefined') {
    try {
      for (const k of Object.keys(chrome)) {
        if (!standardSet || !standardSet.has(k)) {
          result.detectedCustomFromChromeKeys.push(reflectMember(chrome, k));
        }
      }
    } catch (e) {
      result.notes.push('Failed to enumerate chrome keys: ' + String(e));
    }
  }

  // 3. browser.* も同様に（WebExtensions互換層がある場合）
  if (typeof browser !== 'undefined') {
    try {
      for (const k of Object.keys(browser)) {
        if (!standardSet || !standardSet.has(k)) {
          result.detectedCustomFromBrowserKeys.push(reflectMember(browser, k));
        }
      }
    } catch (e) {
      result.notes.push('Failed to enumerate browser keys: ' + String(e));
    }
  }

  return result;
};

function probeNamespace(root, name) {
  const entry = {
    path: `${root}.${name}`,
    exists: false,
    type: null,
    members: null,
    error: null
  };

  let rootObj = null;
  if (root === 'chrome' && typeof chrome !== 'undefined') rootObj = chrome;
  else if (root === 'browser' && typeof browser !== 'undefined') rootObj = browser;

  if (!rootObj) return entry;

  try {
    const target = rootObj[name];
    if (target == null) return entry;
    entry.exists = true;
    entry.type = typeof target;
    if (typeof target === 'object') {
      entry.members = Object.keys(target).map((k) => reflectMember(target, k));
    }
  } catch (e) {
    entry.error = String(e);
  }
  return entry;
}

function reflectMember(parent, key) {
  const out = { name: key };
  try {
    const v = parent[key];
    out.type = typeof v;
    if (v && typeof v === 'object') {
      try {
        out.members = Object.keys(v).map((sk) => ({
          name: sk,
          type: safeTypeof(() => v[sk])
        }));
      } catch (e) {
        out.subError = String(e);
      }
    }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

function safeTypeof(thunk) {
  try {
    return typeof thunk();
  } catch (e) {
    return 'throws';
  }
}
