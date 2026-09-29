/**
 * Data-table view of the current slice (accessibility: every value on the chart is reachable
 * without hovering). Values are read off the same splines the chart draws.
 */
import type { SliceMode } from '../types';
import { curveXRange, evalCurve } from './spline';
import type { Scene } from './scene';
import { fmtTickNits } from './scales';

export interface TableModel {
  mode: SliceMode;
  /** Column sample x in data units (nits or gray). */
  xs: number[];
  rows: { id: string; label: string; color: string; dash: number[]; values: (number | null)[]; excluded: number }[];
}

/** 1-2-5 samples for the gray slice (nits) inside the union of the curves' ranges. */
function nitsSamples(scene: Scene): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const se of scene.series) {
    const r = se.curve ? curveXRange(se.curve) : null;
    if (!r) continue;
    lo = Math.min(lo, r[0]);
    hi = Math.max(hi, r[1]);
  }
  if (!(hi >= lo)) return [];
  // Limit to the visible axis in standard mode, so the table matches what is drawn.
  lo = Math.max(lo, scene.axes.x.u0);
  hi = Math.min(hi, scene.axes.x.u1);
  const out: number[] = [];
  for (let e = Math.floor(lo) - 1; e <= Math.ceil(hi) + 1; e++) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * Math.pow(10, e)).toPrecision(6));
      const u = Math.log10(v);
      if (u >= lo - 1e-9 && u <= hi + 1e-9) out.push(v);
    }
  }
  return out;
}

/** Measured gray rows (union over the visible records), descending (G255 first). */
function graySamples(scene: Scene): number[] {
  const set = new Set<number>();
  for (const se of scene.series) for (const p of se.points) if (p.a >= 0.5) set.add(p.x);
  return [...set].filter((g) => g >= scene.axes.x.u0 - 1e-9 && g <= scene.axes.x.u1 + 1e-9).sort((a, b) => b - a);
}

export function buildTable(scene: Scene): TableModel {
  const xs = scene.mode === 'gray' ? nitsSamples(scene) : graySamples(scene);
  const rows = scene.series.map((se) => ({
    id: se.id,
    label: se.label,
    color: se.style.color,
    dash: se.style.dash,
    values: xs.map((x) => (se.curve ? evalCurve(se.curve, scene.mode === 'gray' ? Math.log10(x) : x) : null)),
    excluded: se.exclusion?.total ?? 0,
  }));
  return { mode: scene.mode, xs, rows };
}

export function columnLabel(mode: SliceMode, x: number): string {
  return mode === 'gray' ? fmtTickNits(x) : `G${Math.round(x)}`;
}

export function tableToTsv(model: TableModel, headers: { record: string; unit: string }): string {
  const head = [headers.record, ...model.xs.map((x) => (model.mode === 'gray' ? `${fmtTickNits(x)} ${headers.unit}` : `G${Math.round(x)}`))];
  const lines = [head.join('\t')];
  for (const r of model.rows) lines.push([r.label + (r.excluded ? ' *' : ''), ...r.values.map((v) => (v === null ? '' : v.toFixed(3)))].join('\t'));
  return lines.join('\n');
}
