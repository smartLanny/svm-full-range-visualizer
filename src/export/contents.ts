/**
 * Export contents (docs/adr/0010, addendum "export contents"): the list a view offers (with the
 * implicit list of legacy targets), the dialog's default choice and the remembered choice per view.
 * Pure functions, unit-tested (contents.test.ts).
 */
import type { MainTab } from '../types';
import { ANIMATION_CONTENT, CURRENT_CONTENT, type ExportAnimation, type ExportContent, type ExportTarget } from './registry';

export interface LegacyContentLabels {
  /** Name of the implicit "frame on screen" content, e.g. "当前画面". */
  current: string;
  currentDetail?: string;
}

/** target.animation(content), or null when it throws (a broken target must not break the dialog). */
export function animationOf(target: ExportTarget, content?: string): ExportAnimation | null {
  try {
    return target.animation(content) ?? null;
  } catch (e) {
    console.warn('Export target animation() failed:', e);
    return null;
  }
}

/**
 * What `target` can export now. Targets with contents() list their own (entries with an empty id,
 * duplicate ids and videos without an animation are dropped); legacy targets get the frame on
 * screen plus, if they have one, their animation.
 */
export function listContents(target: ExportTarget, labels: LegacyContentLabels): ExportContent[] {
  if (target.contents) {
    let list: ExportContent[] = [];
    try {
      list = target.contents() ?? [];
    } catch (e) {
      console.warn('Export target contents() failed:', e);
    }
    const seen = new Set<string>();
    const out: ExportContent[] = [];
    for (const c of list) {
      if (!c || !c.id || seen.has(c.id)) continue;
      if (c.kind === 'video') {
        const anim = animationOf(target, c.id);
        if (!anim) continue;
        seen.add(c.id);
        out.push({ ...c, duration: anim.duration });
      } else {
        seen.add(c.id);
        out.push(c);
      }
    }
    if (out.length) return out;
  }
  const out: ExportContent[] = [{ id: CURRENT_CONTENT, kind: 'image', label: labels.current, detail: labels.currentDetail, current: true, icon: 'screen' }];
  const anim = animationOf(target);
  if (anim) out.push({ id: ANIMATION_CONTENT, kind: 'video', label: anim.label, duration: anim.duration, icon: 'sweep' });
  return out;
}

/**
 * The content the dialog selects when it opens: the one remembered for this view while it is still
 * offered, else the one showing what is on screen, else the first.
 */
export function defaultContent(list: readonly ExportContent[], remembered?: string | null): ExportContent | null {
  if (!list.length) return null;
  return (remembered ? list.find((c) => c.id === remembered) : undefined) ?? list.find((c) => c.current) ?? list[0];
}

/** Last chosen content per view (the dialog's preferences). */
export type RememberedContents = Partial<Record<MainTab, string>>;

/** Sanitise remembered contents read from storage. */
export function parseRemembered(raw: unknown): RememberedContents {
  const out: RememberedContents = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const tab of ['scene3d', 'chart2d', 'stats'] as const) {
    const v = (raw as Record<string, unknown>)[tab];
    if (typeof v === 'string' && v.length > 0 && v.length <= 64) out[tab] = v;
  }
  return out;
}
