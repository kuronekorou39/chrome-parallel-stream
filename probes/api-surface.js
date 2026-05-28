// chrome.* 全namespaceを列挙し、標準API一覧と突き合わせて
// 「標準外（独自）API」を ★ マークで強調する。
//
// importScripts で background.js に取り込まれる前提で、
// self に関数と定数を登録する形をとる。

// 標準 Chrome 拡張 API namespace 一覧。
// https://developer.chrome.com/docs/extensions/reference/api を参考にハードコード。
// （ここに無い名前空間が chrome.* に存在したら「独自API」と判定する）
self.STANDARD_CHROME_EXTENSION_APIS = new Set([
  'accessibilityFeatures', 'action', 'alarms', 'audio', 'bookmarks',
  'browsingData', 'certificateProvider', 'commands', 'contentSettings',
  'contextMenus', 'cookies', 'debugger', 'declarativeContent',
  'declarativeNetRequest', 'desktopCapture', 'devtools', 'dns',
  'documentScan', 'dom', 'downloads', 'enterprise', 'events', 'extension',
  'extensionTypes', 'fileBrowserHandler', 'fileSystemProvider',
  'fontSettings', 'gcm', 'history', 'i18n', 'identity', 'idle',
  'input', 'instanceID', 'loginState', 'management', 'networking',
  'notifications', 'offscreen', 'omnibox', 'pageCapture', 'permissions',
  'platformKeys', 'power', 'printerProvider', 'printing', 'printingMetrics',
  'privacy', 'processes', 'proxy', 'readingList', 'runtime', 'scripting',
  'search', 'sessions', 'sidePanel', 'storage', 'system', 'tabCapture',
  'tabGroups', 'tabs', 'topSites', 'tts', 'ttsEngine', 'types',
  'userScripts', 'vpnProvider', 'wallpaper', 'webAuthenticationProxy',
  'webNavigation', 'webRequest', 'windows',
  // 拡張ランタイム内部のもの(列挙時にノイズになりがちなので標準扱い)
  'csi', 'loadTimes'
]);

const MAX_RECURSION_DEPTH = 2;

self.runApiSurfaceProbe = async function runApiSurfaceProbe() {
  const result = {
    chromeNamespaces: [],
    customNamespaces: [],
    standardNamespaces: [],
    detail: {},
    notes: []
  };

  if (typeof chrome === 'undefined') {
    result.notes.push('chrome object is not available in this context');
    return result;
  }

  let allKeys = [];
  try {
    allKeys = Object.keys(chrome).sort();
  } catch (e) {
    result.notes.push('Object.keys(chrome) failed: ' + String(e));
    return result;
  }
  result.chromeNamespaces = allKeys;

  for (const ns of allKeys) {
    const isStandard = self.STANDARD_CHROME_EXTENSION_APIS.has(ns);
    const entry = {
      name: ns,
      isStandard,
      marker: isStandard ? null : '★ CUSTOM API DETECTED',
      typeof: safeTypeof(() => chrome[ns]),
      members: []
    };

    try {
      const obj = chrome[ns];
      if (obj && typeof obj === 'object') {
        entry.members = dumpObject(obj, 1);
      }
    } catch (e) {
      entry.error = String(e);
    }

    result.detail[ns] = entry;
    if (isStandard) {
      result.standardNamespaces.push(ns);
    } else {
      result.customNamespaces.push(ns);
    }
  }

  return result;
};

// 深さ MAX_RECURSION_DEPTH まで再帰的に object のキーを列挙する。
function dumpObject(obj, depth) {
  let keys = [];
  try {
    keys = Object.keys(obj).sort();
  } catch (e) {
    return [{ name: '<enumeration-failed>', error: String(e) }];
  }
  return keys.map((k) => {
    const member = {
      name: k,
      typeof: safeTypeof(() => obj[k])
    };
    if (depth < MAX_RECURSION_DEPTH) {
      try {
        const child = obj[k];
        if (child && typeof child === 'object') {
          member.subMembers = dumpObject(child, depth + 1);
        }
      } catch (e) {
        member.error = String(e);
      }
    }
    return member;
  });
}

function safeTypeof(thunk) {
  try {
    return typeof thunk();
  } catch (e) {
    return 'throws:' + String(e);
  }
}
