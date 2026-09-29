import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, Repeat, RotateCcw, X } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../ui/cn';
import { Timeline, useTimelineSnapshot, type TimelineChapter } from './timeline';

export interface TimelineBarProps {
  timeline: Timeline;
  chapters?: TimelineChapter[];
  onClose?: () => void;
  /** Optional caption at the left (e.g. "开场动画"). */
  title?: string;
  className?: string;
}

const SPEEDS = [0.5, 1, 1.5, 2];

const fmt = (t: number) => `${t.toFixed(1)}s`;

/**
 * Transport bar: play/pause, replay, scrub (with chapter ticks), speed, loop.
 * Progress is written straight to the DOM every frame (no React re-render).
 */
export function TimelineBar({ timeline, chapters = [], onClose, title, className }: TimelineBarProps) {
  const t = useT();
  const snap = useTimelineSnapshot(timeline);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [hoverChapter, setHoverChapter] = useState<TimelineChapter | null>(null);
  const scrub = useRef<{ wasPlaying: boolean } | null>(null);

  // Chapter times live on the timeline so the global [ / ] shortcuts can step them too.
  const chapterKey = chapters.map((c) => c.t).join(',');
  useEffect(() => {
    timeline.chapterTimes = chapters.map((c) => c.t).sort((a, b) => a - b);
    return () => {
      timeline.chapterTimes = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, chapterKey]);

  useEffect(() => {
    let raf = 0;
    let lastText = '';
    const loop = () => {
      const p = Math.min(1, Math.max(0, timeline.time / timeline.duration));
      if (fillRef.current) fillRef.current.style.width = `${p * 100}%`;
      if (thumbRef.current) thumbRef.current.style.left = `${p * 100}%`;
      const text = `${fmt(timeline.time)} / ${fmt(timeline.duration)}`;
      if (timeRef.current && text !== lastText) {
        timeRef.current.textContent = text;
        lastText = text;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [timeline]);

  const seekFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    timeline.seek(p * timeline.duration);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    scrub.current = { wasPlaying: timeline.playing };
    timeline.pause();
    seekFromEvent(e);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (scrub.current) seekFromEvent(e);
  };
  const onPointerUp = () => {
    if (scrub.current?.wasPlaying && timeline.time < timeline.duration) timeline.play();
    scrub.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      timeline.seek(timeline.time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
    } else if ((e.key === '[' || e.key === ']') && chapters.length) {
      e.preventDefault();
      e.stopPropagation();
      timeline.stepChapter(e.key === '[' ? -1 : 1);
    }
  };

  /** Chapter tick: a 14 px hit target that jumps to the chapter (the track does not start a scrub). */
  const jumpTo = (c: TimelineChapter) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    timeline.seek(c.t);
  };

  const btn = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-surface-4 hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring';

  return (
    <div
      data-timeline-bar=""
      className={cn(
        'pointer-events-auto flex w-[min(720px,calc(100%-32px))] items-center gap-2 rounded-xl bg-surface-2/90 px-2.5 py-2 shadow-panel ring-1 ring-line backdrop-blur-md',
        className,
      )}
    >
      <button type="button" className={btn} aria-label={snap.playing ? t('common.pause') : t('common.play')} title={snap.playing ? t('common.pause') : t('common.play')} onClick={() => timeline.toggle()}>
        {snap.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button type="button" className={btn} aria-label={t('common.replay')} title={t('common.replay')} onClick={() => timeline.restart()}>
        <RotateCcw size={14} />
      </button>
      {title && <span className="hidden whitespace-nowrap text-xs font-medium text-ink-2 sm:inline">{title}</span>}
      <div className="relative flex-1 px-1.5">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={t('common.play')}
          aria-valuemin={0}
          aria-valuemax={snap.duration}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="group relative h-5 cursor-pointer touch-none focus-visible:outline-none"
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#2a3140]" />
          <div ref={fillRef} className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" />
          {chapters.map((c) => (
            <div
              key={`${c.t}-${c.label}`}
              role="button"
              aria-label={c.label}
              onPointerEnter={() => setHoverChapter(c)}
              onPointerLeave={() => setHoverChapter((h) => (h === c ? null : h))}
              onPointerDown={jumpTo(c)}
              className="group/tick absolute top-1/2 z-[1] flex h-5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center"
              style={{ left: `${(c.t / snap.duration) * 100}%` }}
            >
              <span className="h-2.5 w-0.5 rounded bg-ink-3/70 transition-all group-hover/tick:h-3.5 group-hover/tick:w-[3px] group-hover/tick:bg-ink-1" />
            </div>
          ))}
          <div
            ref={thumbRef}
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-ink-1 shadow transition-transform group-hover:scale-110"
          />
          {hoverChapter && (
            // Above the hovered tick (kept inside the track at the ends).
            <div
              className={cn(
                'pointer-events-none absolute bottom-full mb-1.5 whitespace-nowrap rounded bg-surface-4 px-2 py-0.5 text-2xs text-ink-1 ring-1 ring-line',
                hoverChapter.t / snap.duration < 0.12 ? '-translate-x-2' : hoverChapter.t / snap.duration > 0.88 ? '-translate-x-[calc(100%-8px)]' : '-translate-x-1/2',
              )}
              style={{ left: `${(hoverChapter.t / snap.duration) * 100}%` }}
            >
              {hoverChapter.label} · {fmt(hoverChapter.t)}
            </div>
          )}
        </div>
      </div>
      <span ref={timeRef} className="w-[92px] text-right font-mono text-2xs tabular-nums text-ink-3" />
      <select
        aria-label={t('common.speed')}
        title={t('common.speed')}
        value={snap.speed}
        onChange={(e) => timeline.setSpeed(Number(e.target.value))}
        className="h-7 appearance-none rounded-md bg-transparent px-1.5 font-mono text-2xs text-ink-2 hover:bg-surface-4 focus:outline-none"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <button
        type="button"
        className={cn(btn, snap.loop && 'bg-accent-muted text-accent-hover')}
        aria-pressed={snap.loop}
        aria-label={t('common.loop')}
        title={t('common.loop')}
        onClick={() => timeline.setLoop(!snap.loop)}
      >
        <Repeat size={14} />
      </button>
      {onClose && (
        <button type="button" className={btn} aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
