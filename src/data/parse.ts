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

  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const tokens = line.split(/\t+/);
    const grayLevel = parseInt(tokens[0], 10);
    if (Number.isNaN(grayLevel)) continue;

    grayRows.push(grayLevel);
    const rowPoints: (DataPoint | null)[] = [];
    const isDualColMode = tokens.length - 1 >= brightnessCols.length * 1.5;

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
