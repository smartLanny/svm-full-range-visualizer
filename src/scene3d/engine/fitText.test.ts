import { describe, expect, it } from 'vitest';
import { captionLines, ellipsize, ellipsizeStart, titleLines, wrapParts } from './fitText';

// Monospace stand-in: 1 unit per character.
const m = (s: string) => [...s].length;

describe('fitText', () => {
  it('ellipsizes from the end or the start', () => {
    expect([ellipsize('abcdefgh', 8, m), ellipsize('abcdefgh', 5, m), ellipsizeStart('abcdefgh', 5, m)]).toEqual(['abcdefgh', 'abcd…', '…efgh']);
  });

  it('caption: one line when it fits, else device / mode on two lines', () => {
    expect(captionLines('A', 'Xiaomi 18 Pro Max', 'Pro off', 'Pro on', 60, m)).toEqual(['A · Xiaomi 18 Pro Max · Pro off']);
    expect(captionLines('A', 'Xiaomi 18 Pro Max', 'Adaptive refresh Pro off', 'Adaptive refresh Pro on', 30, m)).toEqual([
      'A · Xiaomi 18 Pro Max',
      'Adaptive refresh Pro off',
    ]);
    // Forced two-line form (same shape as the other panel's caption).
    expect(captionLines('B', 'X', 'on', 'off', 60, m, true)).toEqual(['B · X', 'on']);
  });

  it('caption: the device is shortened first; a long mode keeps the part that differs', () => {
    const a = captionLines('A', 'Xiaomi 18 Pro Max', 'Adaptive refresh Pro off', 'Adaptive refresh Pro on', 14, m);
    const b = captionLines('B', 'Xiaomi 17 Ultra Leica', 'DC 120Hz', 'LTPO 120Hz', 14, m);
    expect(a).toEqual(['A · Xiaomi 18…', '…fresh Pro off']);
    expect(b).toEqual(['B · Xiaomi 17…', 'DC 120Hz']);
    // Two modes without a shared start keep their beginning.
    expect(captionLines('B', 'Dev', 'LTPO adaptive 120Hz', 'DC 120Hz', 10, m)[1]).toBe('LTPO adap…');
  });

  it('title: device / mode on two lines before any shortening', () => {
    const title = 'Xiaomi 18 Pro Max · Adaptive refresh Pro on';
    const parts: [string, string] = ['Xiaomi 18 Pro Max', 'Adaptive refresh Pro on'];
    expect(titleLines(title, parts, 60, m)).toEqual([title]);
    expect(titleLines(title, parts, 30, m)).toEqual(parts);
    expect(titleLines(title, parts, 12, m)).toEqual(['Xiaomi 18 P…', 'Adaptive re…']);
    expect(titleLines('Side by side', null, 8, m)).toEqual(['Side by…']);
  });

  it('subtitle wraps at a separator', () => {
    const sub = 'Stroboscopic visibility SVM · level luminance × gray · G<15 hidden';
    expect(wrapParts(sub, ' · ', 80, m)).toEqual([sub]);
    expect(wrapParts(sub, ' · ', 52, m)).toEqual(['Stroboscopic visibility SVM · level luminance × gray', 'G<15 hidden']);
    expect(wrapParts('A: x  ·  B: y', '  ·  ', 5, m)).toEqual(['A: x', 'B: y']);
  });
});
