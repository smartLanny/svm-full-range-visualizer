/**
 * Pointer camera controls with damping. The user's view is stored RELATIVE to the preset's fit
 * (zoom ratio, pan in units of the fit height), so resizing / exporting at another aspect keeps a
 * sensible framing. Perspective: left-drag orbits, right/middle/shift-drag pans. Orthographic
 * presets (top / front / side): drag pans, no rotation. Wheel / pinch zooms toward the cursor.
 */
import * as THREE from 'three';
import { poseBasis } from './camera';

export const DEFAULT_THETA = 0.6;
export const DEFAULT_PHI = 0.98;
const PHI_MIN = 0.16;
const PHI_MAX = 1.5;
const ZOOM_MIN = -0.7;
const ZOOM_MAX = 2.3;
const PAN_MAX = 0.8;

export interface UserView {
  theta: number;
  phi: number;
  /** ln(zoom ratio); 0 = fit. */
  zoom: number;
  /** World pan offset in units of the fit height. */
  pan: THREE.Vector3;
}

export const defaultUserView = (): UserView => ({ theta: DEFAULT_THETA, phi: DEFAULT_PHI, zoom: 0, pan: new THREE.Vector3() });

export interface ControlsHost {
  /** Current orientation / visible height / viewport (drawing-buffer px per CSS px). */
  getFrame(): { theta: number; phi: number; h: number; fitH: number; widthCss: number; heightCss: number; ortho: boolean };
  canInteract(): boolean;
  onChange(): void;
  onDoubleClick(): void;
  onUserStart(): void;
}

export class ViewControls {
  view: UserView = defaultUserView();
  private zoomTarget = 0;
  private zoomAnchor = { x: 0, y: 0 };
  private vTheta = 0;
  private vPhi = 0;
  private vPan = new THREE.Vector3();
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { mode: 'rotate' | 'pan'; lastT: number } | null = null;
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  private el: HTMLElement | null = null;
  dragging = false;

  constructor(private host: ControlsHost) {}

  reset(view?: UserView) {
    this.view = view ?? defaultUserView();
    this.zoomTarget = this.view.zoom;
    this.vTheta = this.vPhi = 0;
    this.vPan.set(0, 0, 0);
  }

  /** Programmatic zoom step (buttons): +1 = in. */
  zoomBy(steps: number) {
    this.zoomAnchor = { x: 0, y: 0 };
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget + steps * 0.35, ZOOM_MIN, ZOOM_MAX);
    this.host.onChange();
  }

  /** Advance damping; returns true while still moving. */
  update(dt: number): boolean {
    let moving = false;
    const f = this.host.getFrame();
    if (!this.drag) {
      if (Math.abs(this.vTheta) > 1e-4 || Math.abs(this.vPhi) > 1e-4) {
        this.view.theta += this.vTheta * dt;
        this.view.phi = THREE.MathUtils.clamp(this.view.phi + this.vPhi * dt, PHI_MIN, PHI_MAX);
        const k = Math.exp(-dt / 0.14);
        this.vTheta *= k;
        this.vPhi *= k;
        moving = true;
      } else {
        this.vTheta = this.vPhi = 0;
      }
      if (this.vPan.lengthSq() > 1e-8) {
        this.view.pan.addScaledVector(this.vPan, dt);
        this.clampPan();
        this.vPan.multiplyScalar(Math.exp(-dt / 0.12));
        moving = true;
      } else this.vPan.set(0, 0, 0);
    }
    const dz = this.zoomTarget - this.view.zoom;
    if (Math.abs(dz) > 1e-4) {
      const step = dz * (1 - Math.exp(-dt / 0.085));
      this.applyZoom(step, f);
      moving = true;
    } else if (dz !== 0) {
      this.applyZoom(dz, f);
    }
    return moving;
  }

  private applyZoom(step: number, f: ReturnType<ControlsHost['getFrame']>) {
    const h = f.h;
    const hNew = h * Math.exp(-step);
    // Keep the point under the cursor fixed (on the target plane).
    const { right, up } = poseBasis(f.theta, f.phi);
    const aspect = f.widthCss / Math.max(1, f.heightCss);
    const off = new THREE.Vector3()
      .addScaledVector(right, (this.zoomAnchor.x * h * aspect) / 2)
      .addScaledVector(up, (this.zoomAnchor.y * h) / 2);
    this.view.pan.addScaledVector(off, (1 - hNew / h) / Math.max(1e-6, f.fitH));
    this.view.zoom += step;
    this.clampPan();
  }

  private clampPan() {
    const p = this.view.pan;
    p.set(THREE.MathUtils.clamp(p.x, -PAN_MAX, PAN_MAX), THREE.MathUtils.clamp(p.y, -PAN_MAX, PAN_MAX), THREE.MathUtils.clamp(p.z, -PAN_MAX, PAN_MAX));
  }

  attach(el: HTMLElement) {
    this.detach();
    this.el = el;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('dblclick', this.onDbl);
    el.addEventListener('contextmenu', this.onContext);
  }

  detach() {
    const el = this.el;
    if (!el) return;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('dblclick', this.onDbl);
    el.removeEventListener('contextmenu', this.onContext);
    this.el = null;
  }

  private onContext = (e: Event) => e.preventDefault();

  private onDbl = (e: MouseEvent) => {
    if (!this.host.canInteract()) return;
    e.preventDefault();
    this.host.onDoubleClick();
  };

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.el!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1, y: -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1) };
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.host.canInteract()) return;
    e.preventDefault();
    this.host.onUserStart();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = THREE.MathUtils.clamp(e.deltaY * unit, -300, 300);
    this.zoomAnchor = this.ndc(e);
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget - dy * 0.0016, ZOOM_MIN, ZOOM_MAX);
    this.host.onChange();
  };

  private onDown = (e: PointerEvent) => {
    if (!this.host.canInteract()) return;
    try {
      this.el?.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic / already-released pointers cannot be captured; dragging still works.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.vTheta = this.vPhi = 0;
    this.vPan.set(0, 0, 0);
    this.host.onUserStart();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      this.drag = null;
      return;
    }
    const f = this.host.getFrame();
    const wantsPan = f.ortho || e.button === 1 || e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey;
    this.drag = { mode: wantsPan ? 'pan' : 'rotate', lastT: performance.now() };
    this.dragging = true;
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.host.canInteract()) return;
    const f = this.host.getFrame();
    const now = performance.now();
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (this.pinch.dist > 0 && dist > 0) {
        this.zoomAnchor = this.ndc({ clientX: cx, clientY: cy });
        const step = Math.log(dist / this.pinch.dist);
        this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget + step, ZOOM_MIN, ZOOM_MAX);
      }
      this.panBy(cx - this.pinch.cx, cy - this.pinch.cy, f, 0);
      this.pinch = { dist, cx, cy };
      this.host.onChange();
      return;
    }
    if (!this.drag) return;
    const dt = Math.max(1e-3, (now - this.drag.lastT) / 1000);
    this.drag.lastT = now;
    if (this.drag.mode === 'rotate') {
      const k = (Math.PI * 1.1) / Math.max(200, f.heightCss);
      const dTh = -dx * k;
      const dPh = -dy * k;
      this.view.theta += dTh;
      this.view.phi = THREE.MathUtils.clamp(this.view.phi + dPh, PHI_MIN, PHI_MAX);
      const a = Math.min(1, dt / 0.05);
      this.vTheta = THREE.MathUtils.lerp(this.vTheta, dTh / dt, a);
      this.vPhi = THREE.MathUtils.lerp(this.vPhi, dPh / dt, a);
    } else {
      this.panBy(dx, dy, f, dt);
    }
    this.host.onChange();
  };

  private panBy(dx: number, dy: number, f: ReturnType<ControlsHost['getFrame']>, dt: number) {
    const { right, up } = poseBasis(f.theta, f.phi);
    const wpp = f.h / Math.max(1, f.heightCss);
    const d = new THREE.Vector3().addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp).multiplyScalar(1 / Math.max(1e-6, f.fitH));
    this.view.pan.add(d);
    this.clampPan();
    if (dt > 0) this.vPan.lerp(d.clone().multiplyScalar(1 / dt), Math.min(1, dt / 0.05));
  }

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      // Drop stale velocity if the pointer rested before release.
      if (this.drag && performance.now() - this.drag.lastT > 80) {
        this.vTheta = this.vPhi = 0;
        this.vPan.set(0, 0, 0);
      }
      this.drag = null;
      this.dragging = false;
      this.host.onChange();
    }
  };
}
