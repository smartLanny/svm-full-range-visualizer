/**
 * Denoise notes (docs/adr/0012 addendum) of a 3D cell under the cursor: pure, so it is unit
 * tested without WebGL. The engine's hover info carries them to the tooltip.
 */
import { displayNotes, type CellNote, type LevelNote } from '../../data/denoise';
import { bracket, gridView } from '../../data/grid';
import type { PanelModel } from './model';

/** A denoise note under the cursor; `who` names the record of a difference map. */
export interface HoverNote {
  who?: 'A' | 'B';
  note: CellNote;
}

export interface CellNotes {
  /** The cell's own note (single / side by side), or A's and the B cells' notes (difference map). */
  notes?: HoverNote[];
  /** The column's level luminance was re-estimated by the denoise (A's column for a diff). */
  level?: LevelNote;
  /** Cell without valid data that no note explains (never measured / out of range). */
  missing?: { who?: 'A' | 'B' };
}

/**
 * Denoise notes of a cell (docs/adr/0012 addendum), looked up in the displayed records' notes by
 * gray + brightness %: the cell's own note; for a difference map A's cell first, then the B cells
 * the bilinear resampling at A's (level luminance, gray) uses (weighted corners only).
 */
export function cellNotes(pm: PanelModel, r: number, c: number): CellNotes {
  const v = pm.view;
  const diff = pm.kind === 'diff';
  const who = diff ? ('A' as const) : undefined;
  const na = displayNotes(pm.record);
  const out: CellNotes = {};
  const notes: HoverNote[] = [];
  const own = na?.noteAt(v.grays[r], v.percents[c]) ?? null;
  if (own) notes.push({ who, note: own });
  const level = na?.levelNoteAt(v.percents[c]);
  if (level) out.level = level;
  const value = pm.values[r]?.[c] ?? null;
  if (!v.points[r][c] && !own) out.missing = { who };
  if (diff && pm.other) {
    const nb = displayNotes(pm.other);
    const bv = gridView(pm.other);
    const ci = bracket(bv.x, v.x[c]);
    const ri = bracket(bv.grays, v.grays[r]);
    let bMissing = false;
    if (ci >= 0 && ri >= 0) {
      const c1 = Math.min(ci + 1, bv.x.length - 1);
      const r1 = Math.min(ri + 1, bv.grays.length - 1);
      const tx = c1 === ci ? 0 : (v.x[c] - bv.x[ci]) / (bv.x[c1] - bv.x[ci]);
      const tz = r1 === ri ? 0 : (v.grays[r] - bv.grays[ri]) / (bv.grays[r1] - bv.grays[ri]);
      const corners: [number, number, number][] = [
        [ri, ci, (1 - tx) * (1 - tz)],
        [ri, c1, tx * (1 - tz)],
        [r1, ci, (1 - tx) * tz],
        [r1, c1, tx * tz],
      ];
      const seen = new Set<string>();
      for (const [rr, cc, w] of corners) {
        if (w <= 1e-9 || seen.has(`${rr}|${cc}`)) continue;
        seen.add(`${rr}|${cc}`);
        const n = nb?.noteAt(bv.grays[rr], bv.percents[cc]) ?? null;
        if (n) notes.push({ who: 'B', note: n });
        else if (!bv.points[rr][cc]) bMissing = true;
      }
    } else bMissing = true;
    if (value === null && v.points[r][c] && bMissing && !notes.some((x) => x.who === 'B' && x.note.action === 'noData')) out.missing = { who: 'B' };
  }
  if (notes.length) out.notes = notes;
  return out;
}
