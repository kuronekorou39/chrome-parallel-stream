// chrome.windows.create の挙動を Android 実機で確かめる。
//
// マルチビュー実現には「別ウィンドウを並べて描画する」が成立する必要があるが、
// Android Chrome は伝統的にこれを別タブとして吸収する。
// type が 'normal' / 'popup' / 'panel' でどう振る舞うかを差分検証する。

const SLEEP_AFTER_CREATE_MS = 500;
const PROBE_WINDOW_RECT = { width: 400, height: 300, left: 50, top: 50 };

self.runWindowsProbe = async function runWindowsProbe() {
  const result = {
    available: typeof chrome !== 'undefined' && !!chrome.windows,
    methods: [],
    properties: [],
    createTests: [],
    notes: []
  };

  if (!result.available) {
    result.notes.push('chrome.windows API is not available');
    return result;
  }

  try {
    const keys = Object.keys(chrome.windows);
    for (const k of keys) {
      const t = typeof chrome.windows[k];
      if (t === 'function') result.methods.push(k);
      else result.properties.push({ name: k, type: t });
    }
    result.methods.sort();
  } catch (e) {
    result.notes.push('Failed to enumerate chrome.windows: ' + String(e));
  }

  const types = ['normal', 'popup', 'panel'];
  for (const type of types) {
    const test = {
      type,
      createPayload: {
        url: 'about:blank',
        type,
        ...PROBE_WINDOW_RECT
      },
      createResult: null,
      createError: null,
      windowsAfter: null,
      windowsAfterError: null,
      cleanupError: null
    };

    try {
      const created = await chrome.windows.create(test.createPayload);
      test.createResult = serializeWindow(created);
    } catch (e) {
      test.createError = errorToObject(e);
    }

    await sleep(SLEEP_AFTER_CREATE_MS);

    try {
      const all = await chrome.windows.getAll({ populate: true });
      test.windowsAfter = all.map(serializeWindow);
    } catch (e) {
      test.windowsAfterError = errorToObject(e);
    }

    // 作ったウィンドウは閉じる（プローブ実行後にゴミを残さない）
    if (test.createResult && test.createResult.id != null) {
      try {
        await chrome.windows.remove(test.createResult.id);
      } catch (e) {
        test.cleanupError = errorToObject(e);
      }
    }

    result.createTests.push(test);
  }

  return result;
};

function serializeWindow(w) {
  if (!w) return null;
  return {
    id: w.id,
    focused: w.focused,
    top: w.top,
    left: w.left,
    width: w.width,
    height: w.height,
    incognito: w.incognito,
    type: w.type,
    state: w.state,
    alwaysOnTop: w.alwaysOnTop,
    sessionId: w.sessionId,
    tabCount: Array.isArray(w.tabs) ? w.tabs.length : undefined,
    tabUrls: Array.isArray(w.tabs) ? w.tabs.map((t) => t.url) : undefined
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errorToObject(e) {
  if (e instanceof Error) {
    return { name: e.name, message: e.message };
  }
  return { value: String(e) };
}
