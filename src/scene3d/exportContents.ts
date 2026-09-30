/**
 * Export contents of the 3D view (docs/adr/0010, addendum "export contents"): what the dialog
 * offers for the current state, and the offscreen scene each content renders. Pure, unit-tested.
 */
import { translate } from '../i18n';
import { recordLabel } from '../data/records';
import type { ExportContent } from '../export/registry';
import { CURRENT_CONTENT } from '../export/registry';
import { MAX_COMPARE_PANELS, PANEL_LETTERS, type Lang, type Representation, type SceneLayout, type SvmRecord, type ViewPreset } from '../types';
import type { ExportScene } from './engine/engine';
import { INTRO_DURATION } from './engine/intro';

export type Scene3DContentId = 'current' | 'top' | 'perspective' | 'sideBySide' | 'diff' | 'intro';

/** Everything the content list depends on (a snapshot of the store + engine). */
export interface Scene3DExportState {
  lang: Lang;
  layout: SceneLayout;
  view: ViewPreset;
  representation: Representation;
  a: SvmRecord | null;
  b: SvmRecord | null;
  /** Side-by-side panels C–F configured. */
  extras: number;
  /** The layout on screen renders (the engine has a model). */
  renders: boolean;
  /** Whether another layout would render (side-by-side / difference need B and data). */
  canRender: (layout: SceneLayout) => boolean;
  /** Intro time (s) while the intro is on screen, else null. */
  introTime: number | null;
  /** The user zoomed / panned / orbited away from the preset's default pose. */
  adjusted: boolean;
}

/** The offscreen scene of a content (null = the screen's own scene). */
export function sceneForContent(id: string | undefined): ExportScene | null {
  switch (id) {
    case 'top':
      return { view: 'top' };
    case 'perspective':
      return { view: 'perspective' };
    case 'sideBySide':
      return { layout: 'sideBySide', view: 'top' };
    case 'diff':
      return { layout: 'diff', view: 'top' };
    default:
      return null;
  }
}

/** Side-by-side panels of the configured comparison: A, B and the extras C–F. */
export function comparePanelCount(extras: number): number {
  return Math.min(MAX_COMPARE_PANELS, 2 + Math.max(0, extras));
}

/**
 * The 3D view's export contents, in dialog order: the frame on screen; the layout on screen in top
 * view and in the default 3D pose; the comparison side by side / the difference map (top view)
 * when they are not the layout on screen; the intro video (record A).
 */
export function scene3dContents(st: Scene3DExportState): ExportContent[] {
  const t = (k: string, v?: Record<string, string | number>) => translate(st.lang, `scene3d.${k}`, v);
  const c = (k: string, v?: Record<string, string | number>) => t(`export.contents.${k}`, v);
  const n = comparePanelCount(st.extras);
  const layoutText = (l: SceneLayout) => (l === 'single' ? c('layoutSingle') : l === 'sideBySide' ? c('layoutSideBySide', { n }) : c('layoutDiff'));
  const repr = t(`representation.${st.representation}`);
  const list: ExportContent[] = [];

  const onScreen =
    st.introTime !== null
      ? c('currentIntro', { t: st.introTime.toFixed(1) })
      : c('currentDetail', { layout: layoutText(st.layout), repr, view: t(`views.${st.view}`) }) + (st.adjusted ? ` · ${c('adjusted')}` : '');
  list.push({ id: CURRENT_CONTENT, kind: 'image', label: translate(st.lang, 'export.content.current'), detail: onScreen, current: true, icon: 'screen' });

  // The screen shows a preset's default pose (no intro, no zoom / pan / orbit).
  const presetOnScreen = st.introTime === null && !st.adjusted;
  if (st.renders) {
    list.push({ id: 'top', kind: 'image', label: c('top'), detail: c('topDetail', { layout: layoutText(st.layout) }), current: presetOnScreen && st.view === 'top', icon: 'top' });
    list.push({
      id: 'perspective',
      kind: 'image',
      label: c('perspective'),
      detail: c('perspectiveDetail', { layout: layoutText(st.layout), repr }),
      current: presetOnScreen && st.view === 'perspective',
      icon: 'perspective',
    });
  }
  const pair = !!st.a && !!st.b && st.a.id !== st.b.id;
  if (pair && st.layout !== 'sideBySide' && st.canRender('sideBySide')) {
    const panels = n > 2 ? `A–${PANEL_LETTERS[n - 1]}` : c('panelsTwo');
    list.push({ id: 'sideBySide', kind: 'image', label: c('sideBySide', { n }), detail: c('sideBySideDetail', { panels }), icon: 'sideBySide' });
  }
  if (pair && st.layout !== 'diff' && st.canRender('diff')) {
    list.push({ id: 'diff', kind: 'image', label: c('diff'), detail: c('diffDetail', { a: recordLabel(st.a!, st.lang), b: recordLabel(st.b!, st.lang) }), icon: 'diff' });
  }
  if (st.a) {
    const name = recordLabel(st.a, st.lang);
    list.push({
      id: 'intro',
      kind: 'video',
      label: c('intro'),
      // The intro always plays record A alone (docs/adr/0010, C6): say so in the other layouts.
      detail: st.layout === 'single' ? c('introDetail', { name }) : c('introOnlyA', { name }),
      duration: INTRO_DURATION,
      icon: 'intro',
    });
  }
  return list;
}
