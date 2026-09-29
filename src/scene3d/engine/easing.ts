export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Progress of t through [t0, t1], clamped. */
export const window01 = (t: number, t0: number, t1: number) => clamp01((t - t0) / Math.max(1e-9, t1 - t0));

export const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInCubic = (x: number) => Math.pow(clamp01(x), 3);
export const easeInOutCubic = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
/** Quintic smootherstep (zero velocity and acceleration at both ends). */
export const smootherstep = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const easeInOutSine = (x: number) => -(Math.cos(Math.PI * clamp01(x)) - 1) / 2;
export const easeOutSine = (x: number) => Math.sin((clamp01(x) * Math.PI) / 2);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Time-based scalar transition (wall clock, static mode). */
export class Tween {
  private from: number;
  private to: number;
  private t0 = 0;
  private dur = 0;
  constructor(value: number) {
    this.from = value;
    this.to = value;
  }
  get target() {
    return this.to;
  }
  value(now: number): number {
    if (this.dur <= 0) return this.to;
    const p = (now - this.t0) / this.dur;
    if (p >= 1) return this.to;
    return lerp(this.from, this.to, easeInOutCubic(p));
  }
  active(now: number) {
    return this.dur > 0 && now - this.t0 < this.dur && this.from !== this.to;
  }
  /** Retarget from the current value. */
  set(to: number, now: number, dur: number) {
    if (to === this.to) return;
    this.from = this.value(now);
    this.to = to;
    this.t0 = now;
    this.dur = dur;
  }
  jump(v: number) {
    this.from = v;
    this.to = v;
    this.dur = 0;
  }
}
