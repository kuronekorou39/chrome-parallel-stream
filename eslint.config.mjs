// 任意の lint。npm 依存は持たない方針なので package.json は置かず、必要なときだけ
//   npx --yes eslint
// で走らせる(初回はネットワークが要る)。見るのは未定義参照と未使用の変数・関数。
import { readdirSync, readFileSync } from 'node:fs';

const browser = ['window', 'document', 'location', 'navigator', 'console', 'fetch', 'URL', 'URLSearchParams',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'performance', 'localStorage', 'sessionStorage', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'matchMedia',
  'getComputedStyle', 'innerWidth', 'innerHeight', 'screen', 'history', 'self', 'top', 'parent', 'Node', 'Element',
  'HTMLElement', 'HTMLVideoElement', 'HTMLMediaElement', 'HTMLIFrameElement', 'Event', 'CustomEvent', 'PointerEvent',
  'Image', 'Blob', 'AbortController', 'crypto', 'structuredClone', 'queueMicrotask', 'CSS', 'DOMParser', 'alert', 'confirm',
  'prompt', 'visualViewport', 'devicePixelRatio', 'scrollTo', 'open', 'close', 'postMessage', 'addEventListener',
  'removeEventListener', 'TextDecoder', 'TextEncoder', 'atob', 'btoa', 'Worker', 'MediaSource', 'AudioContext'];
const globals = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));

// js/ は通常の script としてトップレベルを共有する。互いの関数・定数を未定義と誤検出しないよう、
// 全ファイルのトップレベルの名前を既知の global にする(未使用の検出は tests/consistency.test.mjs)。
const uiNames = readdirSync('js').flatMap((f) =>
  [...readFileSync('js/' + f, 'utf8').matchAll(/^(?:async )?function (\w+)|^(?:const|let) (\w+)/gm)].map((m) => m[1] || m[2]));

export default [
  { ignores: ['dist/', 'chromium-repro/', '_metadata/', '.publish-dev/'] },
  {
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      // chrome = 拡張 API、MV = ext-bridge.js が window に置く橋渡し。
      globals: globals([...browser, 'chrome', 'MV']),
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: ['js/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals([...browser, 'MV', ...uiNames]),
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: ['tools/*.mjs', 'tests/*.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals(['process', 'console', 'URL', 'URLSearchParams']) },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] },
  },
];
