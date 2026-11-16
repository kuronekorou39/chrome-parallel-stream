// Twitch のチャット入力欄で、Android の日本語入力が「最初の1文字で確定してしまう」のを避ける。
//
// 原因は Twitch 側(この拡張でも、ブラウザでもない。普通の Chrome の単体タブでも同じに起きる)。
// 入力欄は Slate の contenteditable で、空のときと文字があるときとで中の要素が別物になっている
// (空: span[data-slate-zero-width] / 文字あり: span[data-slate-string])。空の状態から1文字目を
// 打つと Slate がこの要素を作り直し、変換中の文字が載っていたテキストノードごと DOM から外れる。
// Android の IME はそこで変換を打ち切るので、「か」だけが確定し、続きは別の変換として始まる。
//
// 対処: 入力欄が空のままフォーカスされている間だけ、先頭に空白を1つ入れておく。こうすると
// 最初から「文字あり」の要素になっていて、1文字目で作り直しが起きない。空白は用が済んだら
// (= 何か確定した文字が入ったら)取り除くので、送るメッセージには残らない。
//
// Slate の中身(モデル)を直接書き換える必要があるので MAIN world で動かす。DOM に空白を
// 差し込むだけ(execCommand 等)だと Slate の状態と食い違い、入力欄が壊れる(実機で確認)。
(function twitchChatIme() {
  'use strict';
  if (window.top === window.self) return; // multiview の枠(iframe)内のみ。通常タブの挙動は変えない
  try {
    const a = location.ancestorOrigins;
    const top = a && a.length ? a[a.length - 1] : '';
    if (top !== 'https://kuronekorou39.github.io' && top.indexOf('chrome-extension://') !== 0) return;
  } catch (e) {
    return;
  }
  // PC の IME ではこの不具合は起きない(変換中に要素が作り直されても打ち切られない)。
  if (!/Android/.test(navigator.userAgent)) return;

  const EDITOR_SELECTOR = '[data-slate-editor="true"]';
  const PAD = ' '; // 先頭に入れておく空白
  // Slate と React が自分の更新(選択範囲の反映・再描画)を終えるのを待つ時間。
  // 変換の確定直後やフォーカス直後に即書き換えると、Slate 側の後処理とぶつかる。
  const SETTLE_MS = 40;
  const FIBER_SEARCH_DEPTH = 40; // 入力欄の要素から Slate 本体までの React の階層(実測は 9)

  let composing = false;
  let timer = null;

  const editorEl = () => {
    const el = document.activeElement;
    return el && el.matches && el.matches(EDITOR_SELECTOR) ? el : null;
  };

  // 入力欄の DOM 要素から、React の内部(fiber)をたどって Slate のエディタ本体を取り出す。
  // Twitch の作りが変わって見つからなくなったら null(= 何もしない。入力欄は元の挙動のまま)。
  const slateOf = (el) => {
    try {
      const key = Object.keys(el).find((k) => k.indexOf('__reactFiber') === 0);
      let fiber = key ? el[key] : null;
      for (let i = 0; fiber && i < FIBER_SEARCH_DEPTH; i++, fiber = fiber.return) {
        const ed = fiber.memoizedProps && fiber.memoizedProps.editor;
        if (ed && Array.isArray(ed.children) && typeof ed.insertText === 'function' && typeof ed.delete === 'function') return ed;
      }
    } catch (e) { /* noop */ }
    return null;
  };

  const textOf = (node) => (typeof node.text === 'string' ? node.text : (node.children || []).map(textOf).join(''));
  // 先頭のテキストノードの位置。空白はここへ入れ、ここから取り除く。
  const firstTextPath = (ed) => {
    const path = [];
    let node = ed;
    while (node.children && node.children.length) { path.push(0); node = node.children[0]; }
    return typeof node.text === 'string' ? { path, text: node.text } : null;
  };

  // 入力欄の状態を見て、空白を入れる/取り除く。変換中は一切触らない(触ると変換が切れる)。
  const adjust = () => {
    if (composing) return;
    const el = editorEl();
    if (!el) return;
    const ed = slateOf(el);
    if (!ed) return;
    try {
      const all = ed.children.map(textOf).join('');
      const first = firstTextPath(ed);
      if (!first) return;
      if (all === '') {
        // 空 → 空白を入れておく。カーソルは空白の後ろへ置く(続けて打った文字が後ろに並ぶ)。
        ed.insertText(PAD, { at: { path: first.path, offset: 0 } });
        const end = { path: first.path, offset: PAD.length };
        if (typeof ed.select === 'function') ed.select({ anchor: end, focus: end });
      } else if (all !== PAD && first.text.indexOf(PAD) === 0) {
        // 文字が入った → 空白はもう要らない。先頭の1つだけ取り除く。
        ed.delete({ at: { path: first.path, offset: 0 }, distance: PAD.length, unit: 'character' });
      }
    } catch (e) { /* Slate の API が変わっていたら何もしない */ }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(adjust, SETTLE_MS);
  };

  // フォーカスを外すときに空白だけが残っていたら消す(プレースホルダーを戻す)。
  const clearPadOnBlur = (el) => {
    const ed = slateOf(el);
    if (!ed) return;
    try {
      const first = firstTextPath(ed);
      if (first && ed.children.map(textOf).join('') === PAD) {
        ed.delete({ at: { path: first.path, offset: 0 }, distance: PAD.length, unit: 'character' });
      }
    } catch (e) { /* noop */ }
  };

  const inEditor = (e) => !!(e.target && e.target.closest && e.target.closest(EDITOR_SELECTOR));

  document.addEventListener('compositionstart', (e) => { if (inEditor(e)) composing = true; }, true);
  document.addEventListener('compositionend', (e) => {
    if (!inEditor(e)) return;
    composing = false;
    schedule();
  }, true);
  document.addEventListener('focusin', (e) => { if (inEditor(e)) schedule(); }, true);
  // 送信して空になった/全部消した/変換を使わない文字(英数・絵文字)を打った、を拾う。
  document.addEventListener('input', (e) => { if (inEditor(e)) schedule(); }, true);
  document.addEventListener('keyup', (e) => { if (inEditor(e)) schedule(); }, true);
  // 送信で入力欄が空に戻されたときは input が出ないことがあるので、カーソルの移動でも見直す。
  document.addEventListener('selectionchange', () => { if (editorEl()) schedule(); });
  document.addEventListener('focusout', (e) => {
    if (!inEditor(e)) return;
    composing = false;
    clearTimeout(timer);
    clearPadOnBlur(e.target.closest(EDITOR_SELECTOR));
  }, true);
})();
