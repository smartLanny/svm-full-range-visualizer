/**
 * DEV-only mock ExportTarget for testing the exporter without the real views.
 * Enabled with the query flag `?mockExport` (2D canvas) or `?mockExport=webgl` (WebGL canvas
 * without preserveDrawingBuffer, like the real 3D view). Never part of production bundles:
 * it is only imported behind `import.meta.env.DEV`.
 */
import { registerExportTarget, type ExportSize, type ExportTarget } from '../registry';

const DURATION = 4;

function draw2d(canvas: HTMLCanvasElement, t: number) {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const hue = (t / DURATION) * 300;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, `hsl(${hue}, 70%, 22%)`);
  g.addColorStop(1, `hsl(${(hue + 120) % 360}, 70%, 12%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = Math.max(1, W / 1920);
  for (let x = 0; x <= W; x += W / 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  // Moving ball: x is a pure function of t.
  const p = t / DURATION;
  const r = Math.min(W, H) * 0.06;
  ctx.fillStyle = '#f5b041';
  ctx.beginPath();
  ctx.arc(r + p * (W - 2 * r), H * 0.62 + Math.sin(p * Math.PI * 4) * H * 0.12, r, 0, Math.PI * 2);
  ctx.fill();
  // Text
  const fs = Math.round(Math.min(W, H) * 0.08);
  ctx.fillStyle = '#f3f5f8';
  ctx.font = `600 ${fs}px Inter, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(`Mock export  t = ${t.toFixed(3)} s`, W * 0.05, H * 0.08);
  ctx.font = `500 ${Math.round(fs * 0.45)}px Inter, sans-serif`;
  ctx.fillStyle = '#b6bfcc';
  ctx.fillText(`${W}×${H}`, W * 0.05, H * 0.08 + fs * 1.3);
}

function drawGl(canvas: HTMLCanvasElement, t: number) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: false, antialias: false }) ?? canvas.getContext('webgl', { preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL unavailable');
  const W = canvas.width;
  const H = canvas.height;
  gl.viewport(0, 0, W, H);
  gl.disable(gl.SCISSOR_TEST);
  const p = t / DURATION;
  gl.clearColor(0.03 + 0.2 * p, 0.05, 0.12 + 0.2 * (1 - p), 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);
  // Bars growing with t.
  const n = 12;
  for (let i = 0; i < n; i++) {
    const grow = Math.max(0, Math.min(1, p * 1.6 - i / n / 2));
    const h = Math.round(H * 0.8 * grow * (0.3 + 0.7 * ((i * 7) % n) / n));
    const w = Math.floor(W / (n * 1.5));
    gl.scissor(Math.round(W * 0.08 + i * w * 1.4), Math.round(H * 0.1), w, Math.max(1, h));
    gl.clearColor(i / n, 0.55, 1 - i / n, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  // Moving marker
  const s = Math.round(Math.min(W, H) * 0.05);
  gl.scissor(Math.round(p * (W - s)), H - s * 2, s, s);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.SCISSOR_TEST);
}

function makeTarget(id: 'scene3d' | 'chart2d', webgl: boolean): ExportTarget {
  let canvas: HTMLCanvasElement | null = null;
  return {
    id,
    fileName: () => `SVM_mock_${id}`,
    animation: () => ({ duration: DURATION, label: webgl ? 'Mock WebGL 动画' : 'Mock 动画' }),
    viewSize: () => ({ width: Math.round(window.innerWidth * 0.7 * devicePixelRatio), height: Math.round((window.innerHeight - 48) * devicePixelRatio) }),
    async begin(size: ExportSize) {
      canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      (window as unknown as { __mockExportState: string }).__mockExportState = 'exporting';
    },
    async renderFrame(t: number | null) {
      if (!canvas) throw new Error('begin() not called');
      if (new URLSearchParams(location.search).get('mockFail') === String(t)) throw new Error('mock render failure');
      await new Promise((r) => setTimeout(r, 0));
      const time = t ?? DURATION * 0.6;
      if (webgl) drawGl(canvas, time);
      else draw2d(canvas, time);
      return canvas;
    },
    end() {
      canvas = null;
      (window as unknown as { __mockExportState: string }).__mockExportState = 'idle';
    },
  };
}

export function maybeRegisterMockTargets() {
  const q = new URLSearchParams(location.search);
  if (!q.has('mockExport')) return;
  const webgl = q.get('mockExport') === 'webgl';
  registerExportTarget(makeTarget('scene3d', webgl));
  registerExportTarget(makeTarget('chart2d', webgl));
  (window as unknown as { __mockExportState: string }).__mockExportState = 'idle';
  console.info('[export] mock export targets registered', webgl ? '(webgl)' : '(2d)');
}
