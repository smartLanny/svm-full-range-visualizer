import { describe, expect, it } from 'vitest';
import { Timeline } from './timeline';

describe('Timeline chapters', () => {
  const make = () => {
    const tl = new Timeline({ duration: 13.2 });
    tl.chapterTimes = [0, 1.9, 7, 9.9, 11.3];
    return tl;
  };

  it('steps to the next / previous chapter start', () => {
    const tl = make();
    tl.seek(3);
    expect(tl.stepChapter(1)).toBe(true);
    expect(tl.time).toBe(7);
    expect(tl.stepChapter(1)).toBe(true);
    expect(tl.time).toBe(9.9);
    expect(tl.stepChapter(-1)).toBe(true);
    expect(tl.time).toBe(7);
  });

  it('steps on from a time just on a chapter start (repeated presses advance)', () => {
    const tl = make();
    tl.seek(1.92);
    tl.stepChapter(-1);
    expect(tl.time).toBe(0);
    tl.seek(1.88);
    tl.stepChapter(1);
    expect(tl.time).toBe(7);
  });

  it('stays put past the last / before the first chapter and without chapters', () => {
    const tl = make();
    tl.seek(12);
    expect(tl.stepChapter(1)).toBe(false);
    expect(tl.time).toBe(12);
    tl.seek(0);
    expect(tl.stepChapter(-1)).toBe(false);
    const bare = new Timeline({ duration: 5 });
    expect(bare.stepChapter(1)).toBe(false);
  });
});
