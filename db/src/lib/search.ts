/**
 * Home-page search: device names (zh / en), brand, aliases (source ids such as ip18pm, names as
 * written in source files) and panel codes of the physical units (GH3, GV3). Case, spaces and
 * punctuation are ignored, so "小米17ultra", "mate90" and "gh3" all match.
 */
import type { Catalog, DataType, Device } from '../../catalog/types';

export const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[\s·._\-–—()（）/]+/g, '');

export function searchKeys(d: Device, brands: Catalog['brands']): string[] {
  const b = brands[d.brand];
  return [d.name.zh, d.name.en, b?.zh ?? '', b?.en ?? '', d.id, ...d.aliases, ...d.units.map((u) => u.panel ?? '').filter(Boolean)].map(norm).filter(Boolean);
}

/** What matched, for the result card ("面板 GH3", "别名 ip18pm"); null when only the name matched. */
export function matchReason(d: Device, q: string): string | null {
  const n = norm(q);
  if (!n) return null;
  if (norm(d.name.zh).includes(n) || norm(d.name.en).includes(n)) return null;
  const unit = d.units.find((u) => u.panel && norm(u.panel).includes(n));
  if (unit) return `面板 ${unit.panel}`;
  const alias = d.aliases.find((a) => norm(a).includes(n));
  if (alias) return `别名 ${alias}`;
  return null;
}

/** Every query word must match some key. */
export function matches(d: Device, brands: Catalog['brands'], q: string): boolean {
  const words = q.split(/\s+/).map(norm).filter(Boolean);
  if (!words.length) return true;
  const keys = searchKeys(d, brands);
  const joined = keys.join('|');
  // Whole query without spaces first ("小米 17 Ultra" → "小米17ultra"), then word by word.
  if (keys.some((k) => k.includes(norm(q)))) return true;
  return words.every((w) => joined.includes(w));
}

export const hasData = (d: Device, t: DataType) => d.availability[t].status === 'complete' || d.availability[t].status === 'partial' || d.availability[t].status === 'metrics-only';

export function filterDevices(c: Catalog, q: string, has: DataType | null): Device[] {
  return c.devices.filter((d) => matches(d, c.brands, q) && (!has || hasData(d, has)));
}
