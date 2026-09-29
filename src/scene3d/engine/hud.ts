/**
 * Screen-space overlay rendered inside the WebGL canvas after the scene (so exports include it):
 * axis labels (projected from world anchors each frame), title block and colorbar. Coordinates are
 * device pixels with the origin at the bottom-left; quads are snapped to whole pixels so Canvas2D
 * text stays crisp.
 */
import * as THREE from 'three';
import type { ColormapType } from '../../types';
import { colormapCss, divergingCss } from '../../colormaps';
import { diffColorbarTicks } from './model';
import { fontString, SANS, type TextTexture } from './text';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const rectsOverlap = (a: Rect, b: Rect, pad = 0) => a.x0 < b.x1 + pad && a.x1 + pad > b.x0 && a.y0 < b.y1 + pad && a.y1 + pad > b.y0;

export class Hud {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  private pool: THREE.Mesh[] = [];
  private used = 0;
  private geo = new THREE.PlaneGeometry(1, 1);

  resize(w: number, h: number) {
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  begin() {
    this.used = 0;
  }

  /** Draw a texture quad. (x, y) = top-left corner in px (y up = top edge). */
  quad(tex: THREE.Texture, x: number, yTop: number, w: number, h: number, opacity: number, rotation = 0) {
    if (opacity <= 0.003) return;
    let m = this.pool[this.used];
    if (!m) {
      m = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      m.matrixAutoUpdate = true;
      this.pool.push(m);
      this.scene.add(m);
    }
    this.used++;
    const mat = m.material as THREE.MeshBasicMaterial;
    if (mat.map !== tex) {
      mat.map = tex;
      mat.needsUpdate = true;
    }
    mat.opacity = Math.min(1, opacity);
    m.visible = true;
    m.renderOrder = this.used;
    if (rotation === 0) {
      const left = Math.round(x);
      const top = Math.round(yTop);
      m.position.set(left + w / 2, top - h / 2, 0);
      m.rotation.set(0, 0, 0);
      m.scale.set(w, h, 1);
    } else {
      // Rotated quads: (x, yTop) is the top-left of the ROTATED bounding box.
      const bw = Math.abs(rotation) > 1 ? h : w;
      const bh = Math.abs(rotation) > 1 ? w : h;
      m.position.set(Math.round(x) + bw / 2, Math.round(yTop) - bh / 2, 0);
      m.rotation.set(0, 0, rotation);
      m.scale.set(w, h, 1);
    }
  }

  /** Text texture with its box centered at (cx, cy). Returns the rect. */
  label(tt: TextTexture, cx: number, cy: number, opacity: number): Rect {
    const x0 = Math.round(cx - tt.w / 2);
    const y1 = Math.round(cy + tt.h / 2);
    this.quad(tt.texture, x0, y1, tt.w, tt.h, opacity);
    return { x0, y0: y1 - tt.h, x1: x0 + tt.w, y1 };
  }

  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  dispose() {
    for (const m of this.pool) (m.material as THREE.Material).dispose();
    this.geo.dispose();
  }
}

// --- Backdrop ------------------------------------------------------------------------------

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/**
 * Soft glow in the page background color around every glyph / the bar of a HUD block (shadow
 * only, drawn from off-canvas so the block itself is composited once): invisible on the empty
 * background, keeps the text legible when the user zooms / pans terrain under the HUD.
 */
function withGlow(src: HTMLCanvasElement, bg: string, pad: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width + pad * 2;
  c.height = src.height + pad * 2;
  const ctx = c.getContext('2d')!;
  const off = c.width + src.width + 100;
  ctx.shadowColor = rgba(bg, 0.95);
  ctx.shadowBlur = pad * 0.9;
  ctx.shadowOffsetX = off;
  for (let k = 0; k < 3; k++) ctx.drawImage(src, pad - off, pad);
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.drawImage(src, pad, pad);
  return c;
}

function toTexture(canvas: HTMLCanvasElement, inset: number): TextTexture & { inset: number } {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, w: canvas.width, h: canvas.height, baseline: 0, inset };
}

// --- Title block ---------------------------------------------------------------------------

export interface TitleSpec {
  title: string;
  subtitle: string;
}

export function drawTitleTexture(spec: TitleSpec, scale: number, maxWidthCss: number, bg: string): TextTexture & { inset: number } {
  const titleStyle = { size: 19, weight: 600, color: '#f3f5f8' };
  const subStyle = { size: 12, weight: 500, color: '#8b95a5' };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fit = (text: string, style: { size: number; weight: number }, maxW: number) => {
    ctx.font = fontString(style as never, scale);
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  };
  const maxW = maxWidthCss * scale;
  const title = fit(spec.title, titleStyle, maxW);
  const sub = spec.subtitle ? fit(spec.subtitle, subStyle, maxW) : '';
  ctx.font = fontString(titleStyle as never, scale);
  const tw = ctx.measureText(title).width;
  ctx.font = fontString(subStyle as never, scale);
  const sw = sub ? ctx.measureText(sub).width : 0;
  const pad = Math.ceil(2 * scale);
  const titleH = Math.ceil(titleStyle.size * 1.3 * scale);
  const subH = sub ? Math.ceil(subStyle.size * 1.45 * scale) : 0;
  canvas.width = Math.max(4, Math.ceil(Math.max(tw, sw) + pad * 2));
  canvas.height = Math.max(4, titleH + subH + pad * 2);
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontString(titleStyle as never, scale);
  ctx.fillStyle = titleStyle.color;
  ctx.fillText(title, pad, pad + titleStyle.size * 1.0 * scale);
  if (sub) {
    ctx.font = fontString(subStyle as never, scale);
    ctx.fillStyle = subStyle.color;
    ctx.fillText(sub, pad, pad + titleH + subStyle.size * 1.05 * scale);
  }
  const inset = Math.round(8 * scale);
  return toTexture(withGlow(canvas, bg, inset), inset);
}

// --- Colorbar ------------------------------------------------------------------------------

export interface ColorbarSpec {
  kind: 'svm' | 'diff';
  colormap: ColormapType;
  /** svm: colorMax; diff: symmetric range D. */
  max: number;
  title: string;
  /** Contour levels marked on the bar. */
  marks: number[];
  /** Diff: end annotations (negative end, positive end). */
  ends?: [string, string];
  /** Diff: values exist beyond the (negative, positive) end — the scale saturates there. */
  over?: [boolean, boolean];
  /** Legend chip for cells without valid data (hatched swatch + this label); omitted when none. */
  noData?: string;
  orientation: 'vertical' | 'horizontal';
  /** Bar length in CSS px. */
  length: number;
}

const fmtTick = (v: number) => {
  if (Math.abs(v) < 1e-9) return '0';
  const s = Math.abs(v) < 1 ? v.toFixed(1) : Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
  return v > 0 ? s : `−${s.replace('-', '')}`;
};

export function colorbarTicks(spec: Pick<ColorbarSpec, 'kind' | 'max'>): number[] {
  if (spec.kind === 'diff') return diffColorbarTicks(spec.max).map((v) => Number(v.toFixed(3)));
  const base = [0, 0.4, 1, 2, 3, 4, 6, 8, 10];
  const out = base.filter((v) => v <= spec.max + 1e-9);
  if (out[out.length - 1] < spec.max - 1e-9) {
    // Drop a tick crowding the max.
    if (spec.max - out[out.length - 1] < spec.max * 0.12) out.pop();
    out.push(spec.max);
  }
  return out;
}

export function drawColorbarTexture(spec: ColorbarSpec, scale: number, bg: string): TextTexture & { inset: number } {
  const S = scale;
  const barT = 12; // thickness (CSS px)
  const L = spec.length;
  const tickFont = `500 ${(10.5 * S).toFixed(2)}px ${SANS}`;
  const titleFont = `600 ${(11.5 * S).toFixed(2)}px ${SANS}`;
  const endFont = `500 ${(10 * S).toFixed(2)}px ${SANS}`;
  const ticks = colorbarTicks(spec);
  const labels = ticks.map((v) => {
    if (spec.kind === 'svm') return Math.abs(v - spec.max) < 1e-9 && spec.max >= 4 ? `${fmtTick(v)}+` : fmtTick(v);
    // Diff: signed; a saturating end reads "≥ +R" / "≤ −R".
    const txt = v > 0 ? `+${fmtTick(v)}` : fmtTick(v);
    if (v >= spec.max - 1e-9 && spec.over?.[1]) return `≥ ${txt}`;
    if (v <= -spec.max + 1e-9 && spec.over?.[0]) return `≤ ${txt}`;
    return txt;
  });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = tickFont;
  const maxLabelW = Math.max(...labels.map((l) => ctx.measureText(l).width)) / S;
  ctx.font = titleFont;
  const titleW = ctx.measureText(spec.title).width / S;
  ctx.font = endFont;
  const endW = spec.ends ? Math.max(...spec.ends.map((e) => ctx.measureText(e).width)) / S : 0;
  const colorAt = (u: number) => (spec.kind === 'diff' ? divergingCss(-1 + 2 * u) : colormapCss(spec.colormap, u * spec.max, spec.max));
  const valueToU = (v: number) => (spec.kind === 'diff' ? (v + spec.max) / (2 * spec.max) : v / spec.max);
  // Extension triangles where values continue beyond the scale: the top of the SVM map, the
  // saturating ends of the ΔSVM map.
  const arrowHi = spec.kind === 'svm' || spec.over?.[1] ? 7 : 0;
  const arrowLo = spec.kind === 'diff' && spec.over?.[0] ? 7 : 0;
  const arrow = arrowHi;
  const chip = spec.noData ? 22 : 0; // legend row height (CSS px)
  ctx.font = endFont;
  const chipW = spec.noData ? 12 + 6 + ctx.measureText(spec.noData).width / S : 0;
  /** "No data" legend chip: hatched swatch (as drawn under missing cells) + label; (x, yMid) in px. */
  const drawChip = (x: number, yMid: number) => {
    if (!spec.noData) return;
    const sw = 12 * S;
    const y0 = Math.round(yMid - sw / 2);
    const x0 = Math.round(x);
    ctx.save();
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(x0, y0, sw, sw);
    ctx.beginPath();
    ctx.rect(x0, y0, sw, sw);
    ctx.clip();
    ctx.strokeStyle = '#5b6576';
    ctx.lineWidth = Math.max(1, S);
    // Same direction as the floor hatch in the plot (top-left to bottom-right).
    for (let k = -sw; k < sw * 2; k += 4 * S) {
      ctx.beginPath();
      ctx.moveTo(x0 + k, y0);
      ctx.lineTo(x0 + k + sw, y0 + sw);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, S);
    ctx.strokeRect(x0 + 0.5 * S, y0 + 0.5 * S, sw - S, sw - S);
    ctx.font = endFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#aeb7c4';
    ctx.fillText(spec.noData, x0 + sw + 6 * S, yMid);
  };

  if (spec.orientation === 'vertical') {
    const titleH = 22;
    const endH = spec.ends ? 16 : 0;
    const wCss = Math.max(barT + 6 + maxLabelW + 4, titleW + 2, endW + 2, chipW + 2) + 4;
    const hCss = titleH + arrow + L + arrowLo + endH * 2 + 8 + chip;
    canvas.width = Math.ceil(wCss * S);
    canvas.height = Math.ceil(hCss * S);
    const bx = 2 * S;
    const by = (titleH + arrow + (spec.ends ? endH : 0)) * S; // top of the bar (below the arrow)
    const bw = barT * S;
    const bh = L * S;
    ctx.font = titleFont;
    ctx.fillStyle = '#c9d0db';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(spec.title, bx, 14 * S);
    if (spec.ends) {
      ctx.font = endFont;
      ctx.fillStyle = '#e0714f';
      ctx.fillText(spec.ends[1], bx, (titleH + 9) * S);
    }
    const grad = ctx.createLinearGradient(0, by + bh, 0, by);
    for (let i = 0; i <= 48; i++) grad.addColorStop(i / 48, colorAt(i / 48));
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw, bh);
    if (arrow) {
      ctx.fillStyle = colorAt(1);
      ctx.beginPath();
      ctx.moveTo(bx, by + 0.5);
      ctx.lineTo(bx + bw / 2, by - arrow * S);
      ctx.lineTo(bx + bw, by + 0.5);
      ctx.closePath();
      ctx.fill();
    }
    if (arrowLo) {
      ctx.fillStyle = colorAt(0);
      ctx.beginPath();
      ctx.moveTo(bx, by + bh - 0.5);
      ctx.lineTo(bx + bw / 2, by + bh + arrowLo * S);
      ctx.lineTo(bx + bw, by + bh - 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = Math.max(1, S);
    ctx.strokeRect(bx + 0.5 * S, by + 0.5 * S, bw - S, bh - S);
    // Contour marks.
    ctx.strokeStyle = 'rgba(11,14,20,0.9)';
    ctx.lineWidth = 1.5 * S;
    for (const m of spec.marks) {
      const u = valueToU(m);
      if (u <= 0.001 || u >= 0.999) continue;
      const y = by + bh * (1 - u);
      ctx.beginPath();
      ctx.moveTo(bx, y);
      ctx.lineTo(bx + bw, y);
      ctx.stroke();
    }
    ctx.font = tickFont;
    ctx.textBaseline = 'middle';
    ticks.forEach((v, i) => {
      const u = valueToU(v);
      const y = by + bh * (1 - u);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(bx + bw, Math.round(y - 0.5 * S), 3 * S, Math.max(1, S));
      ctx.fillStyle = '#aeb7c4';
      ctx.fillText(labels[i], bx + bw + 6 * S, y);
    });
    if (spec.ends) {
      ctx.font = endFont;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#4b8bd4';
      ctx.fillText(spec.ends[0], bx, by + bh + (arrowLo + 14) * S);
    }
    drawChip(bx, by + bh + (arrowLo + endH + 4 + chip / 2) * S);
  } else {
    const hCss = 16 + barT + 6 + 14 + 4;
    const labelW = Math.max(titleW, spec.ends ? 0 : 0) + 10;
    const chipGap = spec.noData ? 18 : 0;
    const wCss = labelW + arrowLo + arrow + L + 8 + maxLabelW / 2 + 4 + chipGap + chipW;
    canvas.width = Math.ceil(wCss * S);
    canvas.height = Math.ceil(hCss * S);
    const bx = (labelW + arrowLo) * S;
    const by = 16 * S;
    const bw = L * S;
    const bh = barT * S;
    ctx.font = titleFont;
    ctx.fillStyle = '#c9d0db';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.title, 0, by + bh / 2);
    if (arrowLo) {
      ctx.fillStyle = colorAt(0);
      ctx.beginPath();
      ctx.moveTo(bx + 0.5, by);
      ctx.lineTo(bx - arrowLo * S, by + bh / 2);
      ctx.lineTo(bx + 0.5, by + bh);
      ctx.closePath();
      ctx.fill();
    }
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    for (let i = 0; i <= 48; i++) grad.addColorStop(i / 48, colorAt(i / 48));
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw, bh);
    if (arrow) {
      ctx.fillStyle = colorAt(1);
      ctx.beginPath();
      ctx.moveTo(bx + bw - 0.5, by);
      ctx.lineTo(bx + bw + arrow * S, by + bh / 2);
      ctx.lineTo(bx + bw - 0.5, by + bh);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(11,14,20,0.9)';
    ctx.lineWidth = 1.5 * S;
    for (const m of spec.marks) {
      const u = valueToU(m);
      if (u <= 0.001 || u >= 0.999) continue;
      ctx.beginPath();
      ctx.moveTo(bx + bw * u, by);
      ctx.lineTo(bx + bw * u, by + bh);
      ctx.stroke();
    }
    ctx.font = tickFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ticks.forEach((v, i) => {
      const x = bx + bw * valueToU(v);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(Math.round(x - 0.5 * S), by + bh, Math.max(1, S), 3 * S);
      ctx.fillStyle = '#aeb7c4';
      ctx.fillText(labels[i], x, by + bh + 5 * S);
    });
    if (spec.ends) {
      ctx.font = endFont;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#4b8bd4';
      ctx.fillText(spec.ends[0], bx, by - 3 * S);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#e0714f';
      ctx.fillText(spec.ends[1], bx + bw, by - 3 * S);
    }
    drawChip(bx + bw + (arrow + 8 + maxLabelW / 2 + chipGap) * S, by + bh / 2);
  }
  const inset = Math.round(8 * S);
  return toTexture(withGlow(canvas, bg, inset), inset);
}
