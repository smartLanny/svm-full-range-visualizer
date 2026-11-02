import { describe, expect, it } from 'vitest';
import { formatRoute, legacyRoute, parseRoute, type Route } from './route';

describe('hash routing', () => {
  it('parses the three pages', () => {
    expect(parseRoute('')).toEqual({ page: 'home', q: '', has: null });
    expect(parseRoute('#/')).toEqual({ page: 'home', q: '', has: null });
    expect(parseRoute('#/?q=gh3&has=uniformity')).toEqual({ page: 'home', q: 'gh3', has: 'uniformity' });
    expect(parseRoute('#/?has=bogus')).toEqual({ page: 'home', q: '', has: null });
    expect(parseRoute('#/d/iphone-18-pro-max')).toEqual({ page: 'device', id: 'iphone-18-pro-max', section: null });
    expect(parseRoute('#/d/iphone-18-pro-max/uniformity')).toEqual({ page: 'device', id: 'iphone-18-pro-max', section: 'uniformity' });
    expect(parseRoute('#/c/xiaomi-18-pro-max,iphone-18-pro-max')).toEqual({ page: 'compare', ids: ['xiaomi-18-pro-max', 'iphone-18-pro-max'] });
    expect(parseRoute('#/c/iphone-duo')).toEqual({ page: 'compare', ids: ['iphone-duo'] });
  });

  it('dedupes compare ids and rejects malformed paths', () => {
    expect(parseRoute('#/c/a,a')).toEqual({ page: 'compare', ids: ['a'] });
    expect(parseRoute('#/c/a,b,c').page).toBe('notFound');
    expect(parseRoute('#/d/Bad Id').page).toBe('notFound');
    expect(parseRoute('#/d/x/flicker').page).toBe('notFound');
    expect(parseRoute('#/nope').page).toBe('notFound');
    expect(parseRoute('#flicker').page).toBe('notFound');
  });

  it('formats routes that parse back to themselves', () => {
    const routes: Route[] = [
      { page: 'home', q: '', has: null },
      { page: 'home', q: '小米 17', has: 'svm' },
      { page: 'device', id: 'iphone-duo', section: null },
      { page: 'device', id: 'iphone-duo', section: 'angle' },
      { page: 'compare', ids: ['a-1', 'b-2'] },
    ];
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });

  it('translates old phone-screen-atlas links', () => {
    expect(legacyRoute('?phone=xiaomi-18-pro-max')).toEqual({ page: 'device', id: 'xiaomi-18-pro-max', section: null });
    expect(legacyRoute('?phone=xiaomi-18-pro-max', '#flicker')).toEqual({ page: 'device', id: 'xiaomi-18-pro-max', section: 'svm' });
    expect(legacyRoute('?phone=a&compare=b&uniformity=10')).toEqual({ page: 'compare', ids: ['a', 'b'] });
    expect(legacyRoute('')).toBeNull();
    expect(legacyRoute('?q=1')).toBeNull();
  });
});
