import type { Dataset, DataPoint } from '../types';
import { generateId } from './records';

/**
 * Parse an Excel/TSV paste into a Dataset.
 *
 * Accepted layout: a header row whose cells are brightness percents (at least 3 numeric
 * cells, "%" allowed), followed by one row per gray level. Each brightness column holds
 * either two cells ("nits<TAB>svm", dual-column mode) or one cell "nits svm" (compact mode).
 * Missing / unparsable cells become null (never 0).
 *
 * @param correctionFactor multiplies every nits value (brightness calibration).
 */
export function parseRawData(raw: string, name: string, correctionFactor = 1.0): Dataset {
  const lines = raw.replace(/\r\n?/g, '\n').trim().split('\n');
  if (lines.length < 2) throw new Error('TOO_FEW_LINES');

  let headerLineIdx = -1;
  let brightnessCols: number[] = [];
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const tokens = lines[i].trim().split(/\t+/);
    const potentialCols = tokens
      .map((t) => {
        const val = parseFloat(t.replace('%', ''));
        return Number.isNaN(val) ? null : val;
      })
      .filter((n): n is number => n !== null);
    if (potentialCols.length >= 3) {
      headerLineIdx = i;
      brightnessCols = potentialCols;
      break;
    }
  }
  if (headerLineIdx === -1) throw new Error('NO_HEADER');

  const grayRows: number[] = [];
  const grid: (DataPoint | null)[][] = [];

  // Data rows split on SINGLE tabs: an empty cell (missing measurement) must keep its column
  // instead of shifting the following values left. The layout (dual "nits<TAB>svm" columns vs
  // compact "nits svm" cells) is decided once for the whole table, so rows with missing
  // trailing cells are still read in the right layout.
  const dataRows = lines
    .slice(headerLineIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l && !Number.isNaN(parseInt(l.split('\t')[0], 10)))
    .map((l) => l.split('\t'));
  const isDualColMode = dataRows.some((tokens) => tokens.length - 1 >= brightnessCols.length * 1.5);

  for (const tokens of dataRows) {
    const grayLevel = parseInt(tokens[0], 10);

    grayRows.push(grayLevel);
    const rowPoints: (DataPoint | null)[] = [];

    for (let j = 0; j < brightnessCols.length; j++) {
      let nits = NaN;
      let svm = NaN;
      if (isDualColMode) {
        const nitsIdx = 1 + j * 2;
        if (nitsIdx + 1 < tokens.length) {
          nits = parseFloat(tokens[nitsIdx]);
          svm = parseFloat(tokens[nitsIdx + 1]);
        }
      } else if (1 + j < tokens.length) {
        const parts = tokens[1 + j].trim().split(/\s+/);
        if (parts.length >= 2) {
          nits = parseFloat(parts[0]);
          svm = parseFloat(parts[1]);
        }
      }
      if (Number.isFinite(nits) && Number.isFinite(svm)) {
        rowPoints.push({ gray: grayLevel, brightnessPercent: brightnessCols[j], nits: nits * correctionFactor, svm });
      } else {
        rowPoints.push(null);
      }
    }
    grid.push(rowPoints);
  }
  if (grid.length === 0) throw new Error('NO_ROWS');

  // Level luminance = nits at the max gray row.
  let maxGrayIdx = 0;
  grayRows.forEach((g, idx) => {
    if (g > grayRows[maxGrayIdx]) maxGrayIdx = idx;
  });
  const headerNits = brightnessCols.map((_, c) => grid[maxGrayIdx][c]?.nits ?? 0);

  const data: DataPoint[] = [];
  for (const row of grid) for (const p of row) if (p) data.push(p);

  return {
    id: generateId(),
    name: name.trim() || `Dataset ${new Date().toLocaleTimeString()}`,
    data,
    matrix: { rows: grayRows, cols: brightnessCols, headerNits, grid },
  };
}

export interface RawTable {
  /** Title line found directly above the header row (e.g. "小米 18 Pro Max 自适应刷新 Pro 关"); '' if none. */
  title: string;
  /** Text of this table only (title + header + rows), ready for parseRawData. */
  text: string;
}

const isIntCell = (c: string) => /^-?\d+$/.test(c);
const isNumberCell = (c: string) => Number.isFinite(parseFloat(c.replace('%', ''))) && /^-?\d/.test(c);

/**
 * Split a paste that may hold several tables (each: optional title line, a header row of
 * brightness percents whose first cell is a label such as "亮度条百分比", then gray rows).
 * A paste without such labelled header rows is returned unchanged as one table, so the
 * single-table behaviour of parseRawData is preserved.
 */
export function splitTables(raw: string): RawTable[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const cells = (l: string) => l.split('\t').map((s) => s.trim()).filter(Boolean);
  const headers: number[] = [];
  lines.forEach((l, i) => {
    const c = cells(l);
    if (c.length >= 4 && !isNumberCell(c[0]) && c.slice(1).filter(isNumberCell).length >= 3) headers.push(i);
  });
  if (headers.length === 0) return [{ title: '', text: raw }];

  const starts: { start: number; title: string }[] = headers.map((h, k) => {
    const floor = k > 0 ? headers[k - 1] + 1 : 0;
    for (let i = h - 1; i >= floor; i--) {
      const c = cells(lines[i]);
      if (c.length === 0) continue;
      // The nearest non-empty line above the header is the title unless it is a data row.
      if (isIntCell(c[0]) || c.filter(isNumberCell).length >= 3) break;
      return { start: i, title: c.join(' ') };
    }
    return { start: h, title: '' };
  });
  return starts.map((s, k) => ({
    title: s.title,
    text: lines.slice(k === 0 ? 0 : s.start, k + 1 < starts.length ? starts[k + 1].start : lines.length).join('\n'),
  }));
}
