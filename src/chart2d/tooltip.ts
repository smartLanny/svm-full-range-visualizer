/**
 * Imperative hover tooltip (DOM). Updated from the draw loop — never through React state —
 * so it follows the crosshair every frame, also while a sweep is playing.
 * Labels are data: inserted with textContent only.
 */
import { fmtNits, fmtSvm } from '../data/grid';
import type { RenderResult } from './render';
import type { Scene } from './scene';
import { translate } from '../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface RowEls {
  root: HTMLDivElement;
  line: SVGLineElement;
  value: HTMLSpanElement;
  label: HTMLSpanElement;
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
    root.className = 'flex items-center gap-2 whitespace-nowrap';
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
    root.append(svg, value, label);
    r = { root, line, value, label };
    this.rows[i] = r;
    return r;
  }

  update(res: RenderResult, scene: Scene, hostW: number, hostH: number) {
    const hv = res.hover;
    if (!hv || hv.values.length === 0) {
      this.hide();
      return;
    }
    const x = scene.mode === 'gray' ? Math.pow(10, hv.u) : hv.u;
    this.header.textContent =
      scene.mode === 'gray' ? translate(scene.lang, 'chart2d.tooltip.nits', { v: fmtNits(x) }) : translate(scene.lang, 'chart2d.tooltip.gray', { v: Math.round(x) });
    const vals = [...hv.values].sort((a, b) => b.svm - a.svm);
    const byId = new Map(scene.series.map((s) => [s.id, s]));
    vals.forEach((v, i) => {
      const se = byId.get(v.id);
      if (!se) return;
      const r = this.row(i);
      r.line.setAttribute('stroke', se.style.color);
      r.line.setAttribute('stroke-dasharray', se.style.dash.length ? se.style.dash.map((d) => d * 0.6).join(' ') : 'none');
      r.value.textContent = fmtSvm(v.svm);
      r.label.textContent = se.exclusion ? `${se.label} *` : se.label;
      if (r.root.parentNode !== this.list || this.list.children[i] !== r.root) this.list.insertBefore(r.root, this.list.children[i] ?? null);
    });
    while (this.list.children.length > vals.length) this.list.lastElementChild!.remove();

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
