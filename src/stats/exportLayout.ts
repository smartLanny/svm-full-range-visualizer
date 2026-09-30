/**
 * Layout of the stats page exports (docs/adr/0010, addendum "stats page"): the page frame (title /
 * scope band, body, legend strip), the card grid chosen for the export's size and aspect, the
 * table's columns fitted to the width (in one band or, in portrait, two stacked bands), and text
 * wrapping. Pure: text widths come from a `Measure` callback (a canvas in the app, a fake one in
 * the unit tests), all lengths are CSS px of the on-screen design ("design units") unless noted.
 */

/** Width of `text` in design px at `size` px and `weight`. */
export type Measure = (text: string, size: number, weight?: number) => number;

/** Cache measurements (layout searches measure the same strings many times). */
export function cachedMeasure(m: Measure): Measure {
  const cache = new Map<string, number>();
  return (text, size, weight = 400) => {
    const k = `${weight}|${size}|${text}`;
    let v = cache.get(k);
    if (v === undefined) {
      v = m(text, size, weight);
      cache.set(k, v);
    }
    return v;
  };
}

// ---- text ----------------------------------------------------------------------------------

const ELLIPSIS = '…';
/** CJK ideographs / kana / full-width forms: each character is a line-break opportunity. */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;

/** `text` cut with an ellipsis so it fits `maxW` (unchanged when it fits). */
export function ellipsize(text: string, maxW: number, size: number, weight: number, measure: Measure): string {
  if (measure(text, size, weight) <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join('').trimEnd() + ELLIPSIS, size, weight) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ELLIPSIS : chars.slice(0, lo).join('').trimEnd() + ELLIPSIS;
}

/** Break opportunities: words (with their trailing spaces) and single CJK characters. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of Array.from(text)) {
    if (CJK.test(ch)) {
      if (cur) out.push(cur);
      out.push(ch);
      cur = '';
    } else if (ch === ' ') {
      cur += ch;
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Greedy wrap like CSS `break-words` + `line-clamp-{maxLines}`: breaks between words and CJK
 * characters, inside a word only when it is wider than a whole line; the last kept line gets an
 * ellipsis when text is left over.
 */
export function wrapText(text: string, maxW: number, maxLines: number, size: number, weight: number, measure: Measure): string[] {
  const w = (s: string) => measure(s.trimEnd(), size, weight);
  if (w(text) <= maxW || maxLines <= 1) return [maxLines <= 1 ? ellipsize(text, maxW, size, weight, measure) : text];
  const lines: string[] = [];
  let line = '';
  const queue = tokens(text);
  while (queue.length) {
    if (lines.length === maxLines - 1) {
      // The last allowed line takes the rest, cut with an ellipsis.
      lines.push(ellipsize((line + queue.join('')).trim(), maxW, size, weight, measure));
      return lines;
    }
    const tok = queue.shift()!;
    if (w(line + tok) <= maxW) {
      line += tok;
    } else if (!line) {
      // A single word wider than the line: break it after the last character that fits.
      const chars = Array.from(tok);
      let k = 1;
      while (k < chars.length && w(chars.slice(0, k + 1).join('')) <= maxW) k++;
      lines.push(chars.slice(0, k).join(''));
      if (k < chars.length) queue.unshift(chars.slice(k).join(''));
    } else {
      lines.push(line.trimEnd());
      line = '';
      queue.unshift(tok);
    }
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

// ---- page frame ----------------------------------------------------------------------------

/** Scale of the page chrome (title band, legend strip, margins): 1 at a 900 px short side. */
export function chromeScale(width: number, height: number): number {
  return Math.max(0.5, Math.min(width, height) / 900);
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Heights (design px) of the title band and its padding, as on screen (px-6 py-3.5). */
export const HEADER = { padX: 24, padY: 14, titleLine: 24, scopeGap: 2, scopeLine: 17 } as const;
export const HEADER_H = HEADER.padY * 2 + HEADER.titleLine + HEADER.scopeGap + HEADER.scopeLine;
/** Body padding (p-5) and the legend strip under the table (px-6 py-2, 14 px lines). */
export const BODY_PAD = 20;
export const STRIP = { padX: 24, padY: 8, line: 14, gapY: 4 } as const;

/**
 * The page frame in output px: title band on top, an optional legend strip of `stripLines`
 * lines at the bottom, and the body between them minus its padding.
 */
export function pageFrame(width: number, height: number, stripLines: number): { hs: number; header: Box; strip: Box | null; body: Box } {
  const hs = chromeScale(width, height);
  const headerH = Math.round(HEADER_H * hs);
  const stripH = stripLines > 0 ? Math.round((STRIP.padY * 2 + stripLines * STRIP.line + (stripLines - 1) * STRIP.gapY) * hs) : 0;
  const pad = Math.round(BODY_PAD * hs);
  return {
    hs,
    header: { x: 0, y: 0, w: width, h: headerH },
    strip: stripH ? { x: 0, y: height - stripH, w: width, h: stripH } : null,
    body: { x: pad, y: headerH + pad, w: Math.max(1, width - 2 * pad), h: Math.max(1, height - headerH - stripH - 2 * pad) },
  };
}

// ---- card grid -----------------------------------------------------------------------------

/** On-screen card sizes: grid minmax(310px, 1fr), gap-4. The export allows a slightly narrower card. */
export const CARD_MIN_W = 296;
export const CARD_MAX_W = 460;
export const CARD_GAP = 16;

export interface CardGrid {
  cols: number;
  rows: number;
  /** Output px per design px. */
  scale: number;
  /** Card size in design px (all cards of the export share it, like grid rows on screen). */
  cardW: number;
  cardH: number;
  /** Grid size in output px. */
  width: number;
  height: number;
}

/**
 * Columns, card width and scale that make `n` cards as large as possible inside `box` (output
 * px): for every column count, the card width (CARD_MIN_W…CARD_MAX_W) that balances the width and
 * height limits — so a landscape export gets many columns, a portrait one few, and the cards fill
 * the aspect. `heightAt(cw)` = the (uniform) card height at card width cw (non-increasing).
 * The scale is capped at `maxScale` (few cards on a large export stay readable, not huge).
 */
export function chooseCardGrid(n: number, box: { w: number; h: number }, heightAt: (cw: number) => number, maxScale = Infinity): CardGrid {
  const count = Math.max(1, n);
  let best: CardGrid | null = null;
  let bestScore = -Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // Skip column counts that leave a whole row empty (same rows with fewer columns exists).
    if (cols > 1 && Math.ceil(count / (cols - 1)) === rows) continue;
    let pick: { s: number; cw: number; ch: number } | null = null;
    for (let cw = CARD_MAX_W; cw >= CARD_MIN_W; cw -= 4) {
      const ch = heightAt(cw);
      const sw = box.w / (cols * cw + (cols - 1) * CARD_GAP);
      const sh = box.h / (rows * ch + (rows - 1) * CARD_GAP);
      const s = Math.min(sw, sh, maxScale);
      // Widest card for the best scale (fills the width once the height is the limit).
      if (!pick || s > pick.s + 1e-9) pick = { s, cw, ch };
    }
    if (!pick) continue;
    const width = pick.s * (cols * pick.cw + (cols - 1) * CARD_GAP);
    const height = pick.s * (rows * pick.ch + (rows - 1) * CARD_GAP);
    // Larger cards first; among (nearly) equal scales the one that covers more of the box.
    const score = pick.s * 1000 + (width * height) / (box.w * box.h);
    if (score > bestScore) {
      bestScore = score;
      best = { cols, rows, scale: pick.s, cardW: pick.cw, cardH: pick.ch, width, height };
    }
  }
  return best!;
}

// ---- table ---------------------------------------------------------------------------------

export interface TableFit {
  /** Column indices of each band (the record column, index 0, repeats in every band). */
  bands: number[][];
  /** Output px per design px. */
  scale: number;
  /** Width of every column per band after filling the width (design px). */
  widths: number[][];
  /** Band width (design px, all bands equal) and height of each band (design px). */
  bandW: number;
  bandH: number[];
  /** Gap between stacked bands (design px). */
  gap: number;
}

export const TABLE_BAND_GAP = 24;

/**
 * Fit a table of natural column widths `natural` (design px, index 0 = record column) and band
 * height `bandHeight(columns)` into `box` (output px). Wide boxes use one band; when two stacked
 * bands (`split`: the column indices of each, both starting with 0) give clearly larger text —
 * portrait exports — the table is split. Each band stretches its columns (in proportion) to the
 * full width, like the on-screen `w-full` table.
 */
export function fitTable(natural: number[], box: { w: number; h: number }, bandHeight: (cols: number[]) => number, split: [number[], number[]], maxScale = Infinity): TableFit {
  const all = natural.map((_, i) => i);
  const layouts: number[][][] = [[all], split];
  let best: TableFit | null = null;
  for (const bands of layouts) {
    const natW = Math.max(...bands.map((b) => b.reduce((a, i) => a + natural[i], 0)));
    const heights = bands.map((b) => bandHeight(b));
    const totalH = heights.reduce((a, h) => a + h, 0) + (bands.length - 1) * TABLE_BAND_GAP;
    const s = Math.min(box.w / natW, box.h / totalH, maxScale);
    // Split only for a clear gain (one band is the familiar table).
    if (best && s < best.scale * 1.12) continue;
    const bandW = Math.max(natW, box.w / s);
    const widths = bands.map((b) => {
      const w0 = b.reduce((a, i) => a + natural[i], 0);
      return b.map((i) => (natural[i] * bandW) / w0);
    });
    best = { bands, scale: s, widths, bandW, bandH: heights, gap: TABLE_BAND_GAP };
  }
  return best!;
}
