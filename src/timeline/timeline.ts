import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Animation clock (docs/adr/0003). Views read `timeline.time` (seconds) inside their own
 * render loops and derive the frame as a pure function of it — never via React state.
 * React only subscribes to coarse changes (play/pause/seek/speed/loop/end).
 */
export interface TimelineChapter {
  /** Seconds. */
  t: number;
  label: string;
}

export interface TimelineSnapshot {
  playing: boolean;
  speed: number;
  loop: boolean;
  ended: boolean;
  duration: number;
}

export class Timeline {
  time = 0;
  private _duration: number;
  private _playing = false;
  private _speed = 1;
  private _loop = false;
  private _ended = false;
  private raf = 0;
  private last = 0;
  private listeners = new Set<() => void>();
  private endListeners = new Set<() => void>();
  private snap: TimelineSnapshot;

  constructor(opts: { duration: number; loop?: boolean; speed?: number }) {
    this._duration = Math.max(0.001, opts.duration);
    this._loop = !!opts.loop;
    this._speed = opts.speed ?? 1;
    this.snap = this.makeSnap();
  }

  get duration() {
    return this._duration;
  }
  get playing() {
    return this._playing;
  }
  get speed() {
    return this._speed;
  }
  get loop() {
    return this._loop;
  }
  get ended() {
    return this._ended;
  }
  /** 0..1 */
  get progress() {
    return this.time / this._duration;
  }

  play() {
    if (this._playing) return;
    if (this._ended || this.time >= this._duration) this.time = 0;
    this._ended = false;
    this._playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause() {
    if (!this._playing) return;
    this._playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  /** Jump to t seconds (clamped). Does not change play state. */
  seek(t: number) {
    this.time = Math.min(this._duration, Math.max(0, t));
    this._ended = !this._playing && this.time >= this._duration;
    this.emit();
  }

  /** Chapter start times (seconds, ascending), set by the view that shows chapter ticks. */
  chapterTimes: number[] = [];

  /** Seek to the previous / next chapter start (a small tolerance so repeated presses step on). False if none. */
  stepChapter(dir: -1 | 1): boolean {
    const now = this.time;
    const ts = this.chapterTimes;
    let to: number | undefined;
    if (dir > 0) to = ts.find((x) => x > now + 0.05);
    else for (let i = ts.length - 1; i >= 0 && to === undefined; i--) if (ts[i] < now - 0.05) to = ts[i];
    if (to === undefined) return false;
    this.seek(to);
    return true;
  }

  restart() {
    this.seek(0);
    this._ended = false;
    this.play();
  }

  setSpeed(speed: number) {
    this._speed = speed;
    this.emit();
  }

  setLoop(loop: boolean) {
    this._loop = loop;
    this.emit();
  }

  setDuration(d: number) {
    this._duration = Math.max(0.001, d);
    this.time = Math.min(this.time, this._duration);
    this.emit();
  }

  /** Coarse change listener (not called every frame). */
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  /** Called when playback reaches the end (not when looping). */
  onEnd(fn: () => void) {
    this.endListeners.add(fn);
    return () => {
      this.endListeners.delete(fn);
    };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this._playing = false;
    this.listeners.clear();
    this.endListeners.clear();
  }

  private tick = (now: number) => {
    if (!this._playing) return;
    // Cap dt so a background tab / hitch never makes the animation jump.
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += dt * this._speed;
    if (this.time >= this._duration) {
      if (this._loop) {
        this.time %= this._duration;
      } else {
        this.time = this._duration;
        this._playing = false;
        this._ended = true;
        this.emit();
        for (const fn of [...this.endListeners]) fn();
        return;
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private makeSnap(): TimelineSnapshot {
    return { playing: this._playing, speed: this._speed, loop: this._loop, ended: this._ended, duration: this._duration };
  }

  private emit() {
    this.snap = this.makeSnap();
    for (const fn of [...this.listeners]) fn();
  }
}

/** One Timeline per component instance, disposed on unmount. Duration updates in place. */
export function useTimeline(duration: number, opts?: { loop?: boolean; speed?: number }): Timeline {
  const ref = useRef<Timeline | null>(null);
  if (!ref.current) ref.current = new Timeline({ duration, ...opts });
  const tl = ref.current;
  useEffect(() => {
    if (tl.duration !== duration) tl.setDuration(duration);
  }, [tl, duration]);
  useEffect(() => () => tl.dispose(), [tl]);
  return tl;
}

/** Subscribe a component to coarse timeline state. */
export function useTimelineSnapshot(tl: Timeline): TimelineSnapshot {
  return useSyncExternalStore(tl.subscribe, tl.getSnapshot, tl.getSnapshot);
}

// --- Active timeline registry: lets global shortcuts (Space, ←/→, R) drive whichever
// animation is currently on screen. ---
let active: Timeline | null = null;
const activeListeners = new Set<() => void>();

export function setActiveTimeline(tl: Timeline | null) {
  active = tl;
  for (const fn of [...activeListeners]) fn();
}

export function getActiveTimeline(): Timeline | null {
  return active;
}

export function useActiveTimeline(): Timeline | null {
  return useSyncExternalStore(
    (fn) => {
      activeListeners.add(fn);
      return () => {
        activeListeners.delete(fn);
      };
    },
    () => active,
    () => active,
  );
}

/** Register `tl` as the active timeline while `enabled`. */
export function useRegisterActiveTimeline(tl: Timeline, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    setActiveTimeline(tl);
    return () => {
      if (getActiveTimeline() === tl) setActiveTimeline(null);
    };
  }, [tl, enabled]);
}
