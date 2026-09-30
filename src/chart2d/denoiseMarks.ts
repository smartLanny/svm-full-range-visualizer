/**
 * The denoise (docs/adr/0012 addendum) in the 2D chart: which measured cells a slice point is
 * made of, and what the denoise did to them — for the hollow markers of interpolated points,
 * the tooltip and the data table. Slice points come from slices.ts (key = the grid-view column
 * of a gray slice, the grid-view row of a brightness slice); a point between two measured rows /
 * columns is made of both, with the interpolation weights.
 */
import type { SliceMode, SvmRecord } from '../types';
import { displayNotes, type CellNote } from '../data/denoise';
import { bracket, gridView, logNits } from '../data/grid';

export interface WeightedNote {
  note: CellNote;
  /** Share of the point that comes from this cell (0..1). */
  w: number;
}

/** Matrix cells (raw indices) of slice point `key` at slice parameter `param`, with weights. */
export function pointCells(rec: Pick<SvmRecord, 'matrix'>, mode: SliceMode, param: number, clipLowGray: boolean, key: number): { r: number; c: number; w: number }[] {
  const out: { r: number; c: number; w: number }[] = [];
  const push = (r: number, c: number, w: number) => {
    if (w > 1e-6) out.push({ r, c, w });
  };
  if (mode === 'gray') {
    const v = gridView(rec);
    const G = v.grays;
    if (!G.length || key < 0 || key >= v.x.length) return out;
    const g = Math.min(G[G.length - 1], Math.max(G[0], param));
    const r = Math.max(0, bracket(G, g));
    const r1 = Math.min(r + 1, G.length - 1);
    const t = r1 === r ? 0 : (g - G[r]) / (G[r1] - G[r]);
    push(v.rowIndex[r], v.colIndex[key], 1 - t);
    if (r1 !== r) push(v.rowIndex[r1], v.colIndex[key], t);
  } else {
    const v = gridView(rec, { clipLowGray });
    const X = v.x;
    if (!X.length || key < 0 || key >= v.grays.length) return out;
    const q = Math.min(X[X.length - 1], Math.max(X[0], logNits(param)));
    const c = Math.max(0, bracket(X, q));
    const c1 = Math.min(c + 1, X.length - 1);
    const t = c1 === c ? 0 : (q - X[c]) / (X[c1] - X[c]);
    push(v.rowIndex[key], v.colIndex[c], 1 - t);
    if (c1 !== c) push(v.rowIndex[key], v.colIndex[c1], t);
  }
  return out;
}

/** Denoise notes of the cells of a slice point (empty for a raw record / untouched cells). */
export function pointNotes(rec: Pick<SvmRecord, 'matrix'>, mode: SliceMode, param: number, clipLowGray: boolean, key: number): WeightedNote[] {
  const dn = displayNotes(rec);
  if (!dn) return [];
  const out: WeightedNote[] = [];
  for (const { r, c, w } of pointCells(rec, mode, param, clipLowGray, key)) {
    const note = dn.noteGrid[r]?.[c];
    if (note) out.push({ note, w });
  }
  return out;
}

/** Share of a slice point that comes from interpolated cells (0 = measured only). */
export function interpolatedShare(notes: WeightedNote[]): number {
  let w = 0;
  for (const n of notes) if (n.note.action === 'interpolated') w += n.w;
  return Math.min(1, w);
}

/**
 * Notes of the samples missing in a gap between two drawn nodes (keys k0 < k < k1): the cells of
 * the slice there that the denoise shows as no data.
 */
export function gapNotes(rec: Pick<SvmRecord, 'matrix'>, mode: SliceMode, param: number, clipLowGray: boolean, k0: number, k1: number): CellNote[] {
  const dn = displayNotes(rec);
  if (!dn) return [];
  const out: CellNote[] = [];
  for (let k = Math.min(k0, k1) + 1; k < Math.max(k0, k1); k++)
    for (const { r, c } of pointCells(rec, mode, param, clipLowGray, k)) {
      const note = dn.noteGrid[r]?.[c];
      if (note && note.action === 'noData' && !out.includes(note)) out.push(note);
    }
  return out;
}
