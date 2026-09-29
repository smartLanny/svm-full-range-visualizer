/**
 * Canvas2D text → textures. Used for everything written in the 3D canvas (CJK-safe, offline:
 * Inter comes from the bundled @fontsource CSS, CJK from system fonts). Textures are rendered at
 * device resolution and cached per (text, style, scale).
 */
import * as THREE from 'three';

export const SANS = '"Inter", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Zen Hei", system-ui, sans-serif';

export interface TextStyle {
  /** CSS px. */
  size: number;
  weight?: number;
  color: string;
  /** Halo (outline) color and width in CSS px. */
  halo?: string;
  haloWidth?: number;
  /** Letter spacing in CSS px. */
  tracking?: number;
}

export interface TextTexture {
  texture: THREE.CanvasTexture;
  /** Size in device pixels. */
  w: number;
  h: number;
  /** Distance from the texture top to the text baseline (device px). */
  baseline: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  return measureCtx;
}

export const fontString = (style: TextStyle, scale: number) => `${style.weight ?? 500} ${Math.max(1, style.size * scale).toFixed(2)}px ${SANS}`;

/** Text width in device px. */
export function measureText(text: string, style: TextStyle, scale: number): number {
  const ctx = mctx();
  ctx.font = fontString(style, scale);
  const tracking = (style.tracking ?? 0) * scale;
  return ctx.measureText(text).width + tracking * Math.max(0, [...text].length - 1);
}

export function drawTextTexture(text: string, style: TextStyle, scale: number): TextTexture {
  const size = style.size * scale;
  const halo = style.halo ? (style.haloWidth ?? 2) * scale : 0;
  const pad = Math.ceil(halo + 1);
  const tw = measureText(text, style, scale);
  const ascent = Math.ceil(size * 0.95);
  const descent = Math.ceil(size * 0.3);
  const w = Math.max(2, Math.ceil(tw + pad * 2));
  const h = Math.max(2, ascent + descent + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.font = fontString(style, scale);
  ctx.textBaseline = 'alphabetic';
  const tracking = (style.tracking ?? 0) * scale;
  const ctxAny = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (tracking && 'letterSpacing' in ctx) ctxAny.letterSpacing = `${tracking}px`;
  const baseline = pad + ascent;
  if (halo > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = style.halo!;
    ctx.lineWidth = halo * 2;
    ctx.strokeText(text, pad, baseline);
  }
  ctx.fillStyle = style.color;
  ctx.fillText(text, pad, baseline);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, w, h, baseline };
}

/** Cache of text textures; invalidate when the pixel scale or fonts change. */
export class TextCache {
  private map = new Map<string, TextTexture>();
  private used = new Set<string>();

  get(text: string, style: TextStyle, scale: number): TextTexture {
    const key = `${text}\u0000${style.size}|${style.weight ?? 500}|${style.color}|${style.halo ?? ''}|${style.haloWidth ?? 0}|${style.tracking ?? 0}|${scale.toFixed(3)}`;
    this.used.add(key);
    let tt = this.map.get(key);
    if (!tt) {
      tt = drawTextTexture(text, style, scale);
      this.map.set(key, tt);
    }
    return tt;
  }

  /** Drop textures not requested since the last sweep. */
  sweep() {
    for (const [k, v] of this.map) {
      if (!this.used.has(k)) {
        v.texture.dispose();
        this.map.delete(k);
      }
    }
    this.used.clear();
  }

  clear() {
    for (const v of this.map.values()) v.texture.dispose();
    this.map.clear();
    this.used.clear();
  }
}
