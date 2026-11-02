/** Number formatting shared by the page (Chinese UI; proper minus sign; never invents digits). */

export const MINUS = '−';

/** `digits` significant digits, no exponent: 0.037227 → "0.03723", 296.12 → "296.1", 0.396789 → "0.3968". */
export function fmtSig(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  // Trailing zeros are kept ("0.3700"): they state the precision.
  let s = abs >= 10 ** digits ? abs.toFixed(0) : abs.toPrecision(digits);
  if (s.includes('e')) s = String(Number(s));
  return (v < 0 ? MINUS : '') + s;
}

/** Fixed decimals with a real minus sign. */
export function fmtFixed(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  return (v < 0 && Number(s) !== 0 ? MINUS : '') + s;
}

/** Signed percentage of a ratio − 1: 0.0732 → "+7.3 %", −0.17 → "−17.0 %". */
export function fmtSignedPct(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '—';
  const s = Math.abs(fraction * 100).toFixed(digits);
  if (Number(s) === 0) return `0${digits ? '.' + '0'.repeat(digits) : ''} %`;
  return `${fraction < 0 ? MINUS : '+'}${s} %`;
}

/** Percentage value already in percent units: 92.5633 → "92.6". */
export const fmtPctValue = (v: number, digits = 1) => fmtFixed(v, digits);

/** ISO date-time → "2026-09-18". */
export const isoDate = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);
