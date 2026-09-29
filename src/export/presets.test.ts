import { describe, expect, it } from 'vitest';
import { avcCandidates, avcLevelIndex, codecFamily, vp9Candidates } from './codecs';
import {
  capSize,
  estimateVideoBytes,
  evenSize,
  formatBytes,
  formatDuration,
  frameCount,
  frameTime,
  frameTimestampUs,
  keyframeInterval,
  resolveSize,
  videoBitrate,
} from './presets';

const win = { width: 2400, height: 1350 };

describe('resolveSize', () => {
  it('maps presets to exact pixel sizes', () => {
    expect(resolveSize('16:9', '1080', win)).toEqual({ width: 1920, height: 1080 });
    expect(resolveSize('16:9', '1440', win)).toEqual({ width: 2560, height: 1440 });
    expect(resolveSize('16:9', '2160', win)).toEqual({ width: 3840, height: 2160 });
    expect(resolveSize('9:16', '1080', win)).toEqual({ width: 1080, height: 1920 });
    expect(resolveSize('9:16', '2160', win)).toEqual({ width: 2160, height: 3840 });
    expect(resolveSize('1:1', '1080', win)).toEqual({ width: 1080, height: 1080 });
    expect(resolveSize('1:1', '2160', win)).toEqual({ width: 2160, height: 2160 });
  });
  it('uses (capped) window size for "window"', () => {
    expect(resolveSize('9:16', 'window', win)).toEqual(win);
    expect(resolveSize('16:9', 'window', { width: 8000, height: 4000 })).toEqual({ width: 4096, height: 2048 });
  });
});

describe('sizes', () => {
  it('capSize keeps aspect and a minimum', () => {
    expect(capSize({ width: 5, height: 3 }, 100)).toEqual({ width: 16, height: 16 });
    expect(capSize({ width: 1000, height: 500 }, 500)).toEqual({ width: 500, height: 250 });
  });
  it('evenSize rounds down to even', () => {
    expect(evenSize({ width: 1601, height: 901 })).toEqual({ width: 1600, height: 900 });
    expect(evenSize({ width: 1, height: 1 })).toEqual({ width: 2, height: 2 });
  });
});

describe('frames', () => {
  it('includes the final frame', () => {
    expect(frameCount(10, 30)).toBe(301);
    expect(frameCount(0, 30)).toBe(1);
    expect(frameTime(300, 30, 10)).toBe(10);
    expect(frameTime(301, 30, 10)).toBe(10);
    expect(frameTime(15, 30, 10)).toBe(0.5);
  });
  it('timestamps are monotonic integers', () => {
    const ts = Array.from({ length: 100 }, (_, i) => frameTimestampUs(i, 60));
    for (let i = 1; i < ts.length; i++) {
      expect(Number.isInteger(ts[i])).toBe(true);
      expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    }
    expect(frameTimestampUs(60, 60)).toBe(1e6);
  });
  it('keyframe every 2 s', () => {
    expect(keyframeInterval(30)).toBe(60);
    expect(keyframeInterval(60)).toBe(120);
  });
});

describe('bitrate', () => {
  it('matches the reference points', () => {
    expect(videoBitrate({ width: 1920, height: 1080 }, 30)).toBe(12e6);
    expect(videoBitrate({ width: 1920, height: 1080 }, 60)).toBe(18e6);
    expect(videoBitrate({ width: 2560, height: 1440 }, 30)).toBe(24e6);
    expect(videoBitrate({ width: 3840, height: 2160 }, 30)).toBe(45e6);
    expect(videoBitrate({ width: 1080, height: 1920 }, 30)).toBe(12e6);
  });
  it('has a floor for small sizes', () => {
    expect(videoBitrate({ width: 320, height: 180 }, 30)).toBe(3e6);
  });
  it('estimates size', () => {
    expect(estimateVideoBytes({ width: 1920, height: 1080 }, 30, 10)).toBeCloseTo((12e6 * (301 / 30)) / 8);
  });
});

describe('codecs', () => {
  it('picks the minimum H.264 level', () => {
    expect(avcCandidates({ width: 1920, height: 1080 }, 30)[0]).toBe('avc1.640028');
    expect(avcCandidates({ width: 1920, height: 1080 }, 60)[0]).toBe('avc1.64002A');
    expect(avcCandidates({ width: 2560, height: 1440 }, 30)[0]).toBe('avc1.640032');
    expect(avcCandidates({ width: 3840, height: 2160 }, 30)[0]).toBe('avc1.640033');
    expect(avcCandidates({ width: 3840, height: 2160 }, 60)[0]).toBe('avc1.640034');
    expect(avcCandidates({ width: 2160, height: 3840 }, 30)[0]).toBe('avc1.640033');
    expect(avcLevelIndex({ width: 1280, height: 720 }, 30)).toBe(0);
  });
  it('lists High, Main and Baseline candidates', () => {
    const c = avcCandidates({ width: 1920, height: 1080 }, 30);
    expect(c.some((s) => s.startsWith('avc1.4D00'))).toBe(true);
    expect(c.some((s) => s.startsWith('avc1.42E0'))).toBe(true);
    expect(new Set(c).size).toBe(c.length);
    expect(c.every((s) => /^avc1\.[0-9A-F]{6}$/.test(s))).toBe(true);
  });
  it('vp9 candidates are well-formed', () => {
    for (const s of vp9Candidates({ width: 3840, height: 2160 }, 60)) expect(s).toMatch(/^vp09\.00\.\d\d\.08$/);
    expect(codecFamily('avc1.640028')).toBe('avc');
    expect(codecFamily('vp09.00.40.08')).toBe('vp9');
  });
});

describe('format', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
    expect(formatDuration(75)).toBe('1:15');
  });
});
