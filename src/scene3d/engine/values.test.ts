import { describe, expect, it } from 'vitest';
import { chooseValueFont, formatCellValue, MIN_CSS } from './values';

const fill = (n: number, v: number) => Array.from({ length: n }, () => v);

describe('value table decision (one per layout)', () => {
  it('uses one uniform size that most cells of every panel hold', () => {
    const big = chooseValueFont([fill(50, 20)]);
    // 20 % of the cells are narrow (8 px): the size is set by the 20th percentile of the others.
    const mixed = chooseValueFont([[...fill(10, 8), ...fill(40, 11)]]);
    // Two panels: the smaller panel sets the size for both.
    const two = chooseValueFont([fill(40, 11), [...fill(12, 7.5), ...fill(28, 10)]]);
    expect([big.size, mixed.size, two.size]).toEqual([12.5, 11, 7.5]);
    expect(two.share).toBeGreaterThanOrEqual(0.8);
  });

  it('falls back to the minimum size when enough cells hold it, else prints nothing at all', () => {
    // 70 % hold the minimum size: shown at MIN_CSS.
    const ok = chooseValueFont([[...fill(30, 5), ...fill(70, 7.2)]]);
    // Only 8 of 60 cells could print (the "stray numbers" case): nothing, in every panel.
    const stray = chooseValueFont([[...fill(52, 4), ...fill(8, 9)], fill(60, 3)]);
    // One panel fine, the other too small: the decision is shared, so nothing.
    const shared = chooseValueFont([fill(60, 12), [...fill(40, 5), ...fill(20, 9)]]);
    expect([ok.size, stray.size, shared.size]).toEqual([MIN_CSS, null, null]);
    expect(chooseValueFont([]).size).toBeNull();
    expect(chooseValueFont([[], fill(10, 9)]).size).toBe(9);
  });

  it('formats values with a sign that follows the rounded value', () => {
    expect([formatCellValue(0.004, 'diff'), formatCellValue(-0.5, 'diff'), formatCellValue(12.34, 'svm')]).toEqual(['0.00', '−0.50', '12.3']);
  });
});
