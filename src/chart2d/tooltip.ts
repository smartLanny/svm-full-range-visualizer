/**
 * Imperative hover tooltip (DOM). Updated from the draw loop — never through React state —
 * so it follows the crosshair every frame, also while a sweep is playing.
 * Labels are data: inserted with textContent only.
 */
import { fmtNits, fmtSvm } from '../data/grid';
import type { RenderResult } from './render';
import type { Scene, SeriesModel } from './scene';
import { translate, type TFunction } from '../i18n';
import { noteLines } from '../data/denoiseText';
import { gapNotes, pointNotes } from './denoiseMarks';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface RowEls {
  root: HTMLDivElement;
  line: SVGLineElement;
  value: HTMLSpanElement;
  label: HTMLSpanElement;
  /** Denoise note of the reading under the crosshair (docs/adr/0012 addendum). */
  sub: HTMLDivElement;
}

/**
 * What the denoise did to the reading the crosshair is on (a node within snapping distance), in
 * plain words: action and reason, then the raw reading / interpolation source; null otherwise.
 */
function nodeNote(scene: Scene, se: SeriesModel, key: number | undefined, t: TFunction): string | null {
  if (key === undefined) return null;
  const notes = pointNotes(se.rec, scene.mode, scene.param, scene.clipLowGray, key);
  if (!notes.length) return null;
  const main = notes.reduce((a, b) => (b.w > a.w ? b : a)).note;
  const l = noteLines(main, t);
  return [`${l.action} · ${l.reason}`, l.source, l.raw].filter(Boolean).join('\n');
}

export class ChartTooltip {
  private header: HTMLDivElement;
  private list: HTMLDivElement;
  private rows: RowEls[] = [];
  private shown = false;

  constructor(private el: HTMLDivElement) {
    el.replaceChildren();
    this.header = document.createElement('div');
    this.header.className = 'mb-1.5 border-b border-line pb-1.5 text-2xs font-medium tabular-nums text-ink-2';
    this.list = document.createElement('div');
    this.list.className = 'flex flex-col gap-1';
    el.append(this.header, this.list);
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.el.style.display = 'none';
  }

  private row(i: number): RowEls {
    let r = this.rows[i];
    if (r) return r;
    const root = document.createElement('div');
    const main = document.createElement('div');
    main.className = 'flex items-center gap-2 whitespace-nowrap';
    const sub = document.createElement('div');
    sub.className = 'mt-0.5 whitespace-pre-line pl-[26px] text-2xs leading-snug text-ink-3';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '6');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.flex = 'none';
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '1');
    line.setAttribute('x2', '17');
    line.setAttribute('y1', '3');
    line.setAttribute('y2', '3');
    line.setAttribute('stroke-width', '2.5');
    svg.append(line);
    const value = document.createElement('span');
    value.className = 'w-9 text-xs font-semibold tabular-nums text-ink-1';
    const label = document.createElement('span');
    label.className = 'text-2xs text-ink-2';
    main.append(svg, value, label);
    root.append(main, sub);
    r = { root, line, value, label, sub };
    this.rows[i] = r;
    return r;
  }

  update(res: RenderResult, scene: Scene, hostW: number, hostH: number) {
    const hv = res.hover;
    if (!hv || hv.values.length + hv.gaps.length === 0) {
      this.hide();
      return;
    }
    const x = scene.mode === 'gray' ? Math.pow(10, hv.u) : hv.u;
    this.header.textContent =
      scene.mode === 'gray' ? translate(scene.lang, 'chart2d.tooltip.nits', { v: fmtNits(x) }) : translate(scene.lang, 'chart2d.tooltip.gray', { v: Math.round(x) });
    const vals = [...hv.values].sort((a, b) => b.svm - a.svm);
    const byId = new Map(scene.series.map((s) => [s.id, s]));
    const t: TFunction = (k, v) => translate(scene.lang, k, v);
    const setRow = (i: number, se: SeriesModel, value: string, sub: string | null) => {
      const r = this.row(i);
      r.line.setAttribute('stroke', se.style.color);
      r.line.setAttribute('stroke-dasharray', se.style.dash.length ? se.style.dash.map((d) => d * 0.6).join(' ') : 'none');
      r.value.textContent = value;
      r.label.textContent = se.label;
      r.sub.textContent = sub ?? '';
      r.sub.style.display = sub ? '' : 'none';
      if (r.root.parentNode !== this.list || this.list.children[i] !== r.root) this.list.insertBefore(r.root, this.list.children[i] ?? null);
    };
    let n = 0;
    for (const v of vals) {
      const se = byId.get(v.id);
      if (se) setRow(n++, se, fmtSvm(v.svm), nodeNote(scene, se, v.node, t));
    }
    // Records with a gap under the crosshair: no valid data there, and why (denoise notes).
    for (const g of hv.gaps) {
      const se = byId.get(g.id);
      if (!se) continue;
      const notes = gapNotes(se.rec, scene.mode, scene.param, scene.clipLowGray, g.keys[0], g.keys[1]);
      const why = notes.length ? noteLines(notes[0], t).reason : null;
      setRow(n++, se, '—', [t('common.noValidData'), why].filter(Boolean).join(' · '));
    }
    while (this.list.children.length > n) this.list.lastElementChild!.remove();

    if (!this.shown) {
      this.shown = true;
      this.el.style.display = 'block';
    }
    // position: right of the crosshair, flipped when it would overflow
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const gap = 14;
    let left = hv.px + gap;
    if (left + w > hostW - 8) left = hv.px - gap - w;
    left = Math.max(8, left);
    const top = Math.min(hostH - h - 8, Math.max(8, hv.py - h / 2));
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}
