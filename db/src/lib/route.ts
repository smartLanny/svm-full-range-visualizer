/**
 * Hash routing of the database page (works from any static sub-path, e.g. GitHub Pages; not from
 * file://, where the browser blocks the data fetches).
 *
 *   #/                     home (device grid); optional ?q=<search>&has=<type>
 *   #/d/<id>[/<section>]   device page; section = uniformity | svm | reflectance | angle
 *   #/c/<id1>,<id2>        compare two devices (one id: pick the second one on the page)
 *   #/rank                 uniformity leaderboard; optional ?cond=300|100|10&by=area|ninePoint|deviation|cctArea
 *
 * The retired phone-screen-atlas used ?phone=<id>&compare=<id>; legacyRoute() turns those links
 * into the new routes so old shared links keep working once the atlas address serves this page.
 */
import type { DataType } from '../../catalog/types';
import { isRankCond, isRankMetric, type RankCond, type RankMetric } from './ranking';

export const SECTIONS = ['uniformity', 'svm', 'reflectance', 'angle'] as const satisfies readonly DataType[];
export type Section = (typeof SECTIONS)[number];

export type Route =
  | { page: 'home'; q: string; has: DataType | null }
  | { page: 'device'; id: string; section: Section | null }
  | { page: 'compare'; ids: string[] }
  | { page: 'rank'; cond: RankCond; by: RankMetric }
  | { page: 'notFound'; path: string };

const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse a location.hash ("#/d/xiaomi-18-pro-max", "", "#/c/a,b"). */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const parts = pathPart.split('/').filter(Boolean).map(decode);

  if (parts.length === 0) {
    const has = params.get('has');
    return {
      page: 'home',
      q: params.get('q') ?? '',
      has: has && isSection(has) ? has : null,
    };
  }
  if (parts[0] === 'd' && parts.length >= 2 && parts.length <= 3 && ID.test(parts[1])) {
    const section = parts[2] ?? null;
    if (section !== null && !isSection(section)) return { page: 'notFound', path: pathPart };
    return { page: 'device', id: parts[1], section };
  }
  if (parts[0] === 'rank' && parts.length === 1) {
    const cond = params.get('cond');
    const by = params.get('by');
    return {
      page: 'rank',
      cond: isRankCond(cond) ? cond : '300',
      by: isRankMetric(by) ? by : 'area',
    };
  }
  if (parts[0] === 'c' && parts.length === 2) {
    const ids = [
      ...new Set(
        parts[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (ids.length >= 1 && ids.length <= 2 && ids.every((id) => ID.test(id))) return { page: 'compare', ids };
  }
  return { page: 'notFound', path: pathPart };
}

/** Hash for a route (inverse of parseRoute for valid routes). */
export function formatRoute(r: Route): string {
  switch (r.page) {
    case 'home': {
      const p = new URLSearchParams();
      if (r.q) p.set('q', r.q);
      if (r.has) p.set('has', r.has);
      const qs = p.toString();
      return qs ? `#/?${qs}` : '#/';
    }
    case 'device':
      return `#/d/${r.id}${r.section ? `/${r.section}` : ''}`;
    case 'compare':
      return `#/c/${r.ids.join(',')}`;
    case 'rank': {
      const p = new URLSearchParams();
      if (r.cond !== '300') p.set('cond', r.cond);
      if (r.by !== 'area') p.set('by', r.by);
      const qs = p.toString();
      return qs ? `#/rank?${qs}` : '#/rank';
    }
    case 'notFound':
      return '#/';
  }
}

/**
 * Replace the current hash without a history entry (search box, filters) and tell the router: a
 * replaceState fires no hashchange, so without the event the router would keep the old route and a
 * later link to the same address (the logo's #/) would change nothing on the page.
 */
export const ROUTE_EVENT = 'screendb:route';
export function replaceRoute(r: Route): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${formatRoute(r)}`);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export const deviceHref = (id: string, section: Section | null = null) => formatRoute({ page: 'device', id, section });
export const compareHref = (ids: string[]) => formatRoute({ page: 'compare', ids });
export const rankHref = (cond: RankCond = '300', by: RankMetric = 'area') => formatRoute({ page: 'rank', cond, by });

/**
 * Old phone-screen-atlas query (?phone=A[&compare=B]) → new route, or null when the search has
 * no atlas parameters. Anchors of the old sections (#flicker, #uniformity …) become the section.
 */
export function legacyRoute(search: string, hash = ''): Route | null {
  const p = new URLSearchParams(search);
  const phone = p.get('phone');
  if (!phone || !ID.test(phone)) return null;
  const other = p.get('compare');
  if (other && ID.test(other) && other !== phone) return { page: 'compare', ids: [phone, other] };
  const anchor = hash.replace(/^#/, '');
  const section: Section | null =
    anchor === 'flicker' ? 'svm' : anchor === 'viewing-angle' ? 'angle' : anchor === 'uniformity' || anchor === 'reflectance' ? anchor : null;
  return { page: 'device', id: phone, section };
}
