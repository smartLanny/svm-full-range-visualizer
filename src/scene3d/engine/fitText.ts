/**
 * Fitting HUD text into a width budget (pure; the width function is injected so it can be unit
 * tested without a canvas). Record names wrap to two lines (device / mode) before anything is
 * shortened, and the device is shortened before the mode: the mode is what tells two records of
 * one device apart.
 */
export type Measure = (text: string) => number;

/** Shorten with a trailing ellipsis to fit `maxW` (at least one character is kept). */
export function ellipsize(text: string, maxW: number, measure: Measure): string {
  if (measure(text) <= maxW) return text;
  const chars = [...text];
  let lo = 1;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${chars.slice(0, mid).join('').trimEnd()}…`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, Math.max(1, lo)).join('').trimEnd()}…`;
}

/** Shorten keeping the end ("…tail"), for texts whose distinguishing part is at the end. */
export function ellipsizeStart(text: string, maxW: number, measure: Measure): string {
  if (measure(text) <= maxW) return text;
  const chars = [...text];
  let lo = 1;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`…${chars.slice(chars.length - mid).join('').trimStart()}`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `…${chars.slice(chars.length - Math.max(1, lo)).join('').trimStart()}`;
}

/** Length (characters) of the common prefix of two strings. */
export function commonPrefixLength(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/**
 * Lines of a side-by-side panel caption ("A · device · mode"): one line when it fits, else two
 * (id · device / mode). The device part is shortened first; a mode that still does not fit keeps
 * the part that differs from the other panel's mode (e.g. "…Pro off" vs "…Pro on"). `twoLines`
 * forces the two-line form (so the captions of both panels have the same shape).
 */
export function captionLines(id: string, device: string, mode: string, otherMode: string | null, maxW: number, measure: Measure, twoLines = false): string[] {
  const one = mode ? `${id} · ${device} · ${mode}` : `${id} · ${device}`;
  if (measure(one) <= maxW && !(twoLines && mode)) return [one];
  const prefix = `${id} · `;
  const head = `${prefix}${ellipsize(device, Math.max(1, maxW - measure(prefix)), measure)}`;
  if (!mode) return [head];
  let tail = mode;
  if (measure(mode) > maxW) {
    const shared = otherMode ? commonPrefixLength(mode, otherMode) : 0;
    tail = shared >= 3 ? ellipsizeStart(mode, maxW, measure) : ellipsize(mode, maxW, measure);
  }
  return [head, tail];
}

/**
 * Lines of the title of a single record ("device · mode"): one line when it fits, else device /
 * mode on two lines (each shortened only if it still does not fit), else one shortened line.
 */
export function titleLines(title: string, parts: [string, string] | null, maxW: number, measure: Measure): string[] {
  if (measure(title) <= maxW) return [title];
  if (parts && parts[0] && parts[1]) return [ellipsize(parts[0], maxW, measure), ellipsize(parts[1], maxW, measure)];
  return [ellipsize(title, maxW, measure)];
}

/**
 * Wrap a " · "-separated line (subtitle) to at most two lines at a separator: as many leading
 * parts as fit on the first line, the rest on the second (shortened only if it still does not
 * fit). One line when it fits.
 */
export function wrapParts(text: string, sep: string, maxW: number, measure: Measure): string[] {
  if (measure(text) <= maxW) return [text];
  const parts = text.split(sep);
  if (parts.length < 2) return [ellipsize(text, maxW, measure)];
  let k = parts.length - 1;
  while (k > 1 && measure(parts.slice(0, k).join(sep)) > maxW) k--;
  return [ellipsize(parts.slice(0, k).join(sep), maxW, measure), ellipsize(parts.slice(k).join(sep), maxW, measure)];
}
