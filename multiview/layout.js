// popup から呼ばれるレイアウト計算ヘルパ。
// 入力: count (1〜4), mode ('auto' | 'manual'), screenSize
// 出力: 各ウィンドウの { left, top, width, height } 配列
//
// Auto:
//   1画面 → フル
//   2画面 → 左右 1x2
//   3画面 → 2x2 のうち 3 つ (左上 / 右上 / 左下)。右下は空き
//   4画面 → 2x2
// Manual:
//   全部 800x600 で中央寄せ、各ウィンドウを 40px ずつずらして全部見える状態に

(function () {
  const MANUAL_WIDTH = 800;
  const MANUAL_HEIGHT = 600;
  const MANUAL_OFFSET = 40;
  const MAX_COUNT = 4;

  function compute(count, mode, screen) {
    if (count <= 0) return [];
    count = Math.min(count, MAX_COUNT);
    if (mode === 'manual') return computeManual(count, screen);
    return computeAuto(count, screen);
  }

  function computeAuto(count, s) {
    const X = Math.floor(s.availLeft || 0);
    const Y = Math.floor(s.availTop || 0);
    const W = Math.floor(s.availWidth);
    const H = Math.floor(s.availHeight);
    const halfW = Math.floor(W / 2);
    const halfH = Math.floor(H / 2);

    switch (count) {
      case 1:
        return [{ left: X, top: Y, width: W, height: H }];
      case 2:
        return [
          { left: X, top: Y, width: halfW, height: H },
          { left: X + halfW, top: Y, width: W - halfW, height: H }
        ];
      case 3:
        return [
          { left: X, top: Y, width: halfW, height: halfH },
          { left: X + halfW, top: Y, width: W - halfW, height: halfH },
          { left: X, top: Y + halfH, width: halfW, height: H - halfH }
        ];
      case 4:
        return [
          { left: X, top: Y, width: halfW, height: halfH },
          { left: X + halfW, top: Y, width: W - halfW, height: halfH },
          { left: X, top: Y + halfH, width: halfW, height: H - halfH },
          { left: X + halfW, top: Y + halfH, width: W - halfW, height: H - halfH }
        ];
    }
    return [];
  }

  function computeManual(count, s) {
    const X0 = Math.floor(s.availLeft || 0);
    const Y0 = Math.floor(s.availTop || 0);
    const W = Math.floor(s.availWidth);
    const H = Math.floor(s.availHeight);
    const baseLeft = X0 + Math.floor((W - MANUAL_WIDTH) / 2);
    const baseTop = Y0 + Math.floor((H - MANUAL_HEIGHT) / 2);
    const rects = [];
    for (let i = 0; i < count; i++) {
      rects.push({
        left: baseLeft + i * MANUAL_OFFSET,
        top: baseTop + i * MANUAL_OFFSET,
        width: MANUAL_WIDTH,
        height: MANUAL_HEIGHT
      });
    }
    return rects;
  }

  window.MultiviewLayout = { compute };
})();
