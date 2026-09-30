/**
 * Export contents of the 2D chart (docs/adr/0010, addendum "export contents"): the frame on screen,
 * the gray slice and the brightness slice at their current values, and both sweep videos — with
 * the current axis mode, visible records and styles. Pure, unit-tested.
 */
import { translate } from '../i18n';
import { CURRENT_CONTENT, safeFileName, type ExportAnimation, type ExportContent } from '../export/registry';
import type { AxisMode, Lang, SliceMode } from '../types';
import { fmtLevel, GRAY_SWEEP, LEVEL_SWEEP, SWEEP_DURATION } from './slices';

export type Chart2DContentId = 'current' | 'graySlice' | 'levelSlice' | 'graySweep' | 'levelSweep';

/** Everything the content list depends on. */
export interface Chart2DExportState {
  lang: Lang;
  sliceMode: SliceMode;
  sliceGray: number;
  sliceNits: number;
  axisMode: AxisMode;
  /**
   * Slice parameter of the frame on screen when it is not the static slice (a sweep frame or a
   * glide into / out of it), else null.
   */
  animatedParam: number | null;
}

/** Slice mode a content renders (null = the screen's own). */
export function contentSliceMode(id: string | undefined): SliceMode | null {
  if (id === 'graySlice' || id === 'graySweep') return 'gray';
  if (id === 'levelSlice' || id === 'levelSweep') return 'brightness';
  return null;
}

/** The content is one of the sweep videos. */
export function isSweepContent(id: string | undefined): boolean {
  return id === 'graySweep' || id === 'levelSweep';
}

/** The content is one of the static slices. */
export function isSliceContent(id: string | undefined): boolean {
  return id === 'graySlice' || id === 'levelSlice';
}

/** Base file name of a slice image: SVM_2D_G127 / SVM_2D_100nits. */
export function sliceFileName(mode: SliceMode, param: number): string {
  return safeFileName(`SVM_2D_${mode === 'gray' ? `G${Math.round(param)}` : `${fmtLevel(param)}nits`}`);
}

/** Base file name of a sweep video: SVM_2D_sweep_G255-G50 / SVM_2D_sweep_500-2nits. */
export function sweepFileName(mode: SliceMode): string {
  return safeFileName(mode === 'gray' ? `SVM_2D_sweep_G${GRAY_SWEEP[0]}-G${GRAY_SWEEP[1]}` : `SVM_2D_sweep_${LEVEL_SWEEP[0]}-${LEVEL_SWEEP[1]}nits`);
}

/** The sweep animation of a slice mode. */
export function sweepAnimation(lang: Lang, mode: SliceMode): ExportAnimation {
  return { duration: SWEEP_DURATION, label: translate(lang, mode === 'gray' ? 'chart2d.sweep.gray' : 'chart2d.sweep.level'), fileName: sweepFileName(mode) };
}

export function chart2dContents(st: Chart2DExportState): ExportContent[] {
  const t = (k: string, v?: Record<string, string | number>) => translate(st.lang, `chart2d.${k}`, v);
  const axis = t(`axisMode.${st.axisMode}`);
  const gray = String(Math.round(st.sliceGray));
  const nits = fmtLevel(st.sliceNits);
  const sliceName = (mode: SliceMode, param: number) => (mode === 'gray' ? t('export.graySlice', { v: Math.round(param) }) : t('export.levelSlice', { v: fmtLevel(param) }));
  const staticOnScreen = st.animatedParam === null;
  const current =
    st.animatedParam === null
      ? t('export.currentStatic', { slice: sliceName(st.sliceMode, st.sliceMode === 'gray' ? st.sliceGray : st.sliceNits), axis })
      : t('export.currentSweep', { slice: sliceName(st.sliceMode, st.animatedParam) });
  return [
    { id: CURRENT_CONTENT, kind: 'image', label: translate(st.lang, 'export.content.current'), detail: current, current: true, icon: 'screen' },
    {
      id: 'graySlice',
      kind: 'image',
      label: t('export.graySlice', { v: gray }),
      detail: t('export.graySliceDetail', { axis }),
      current: staticOnScreen && st.sliceMode === 'gray',
      icon: 'slice',
    },
    {
      id: 'levelSlice',
      kind: 'image',
      label: t('export.levelSlice', { v: nits }),
      detail: t('export.levelSliceDetail', { axis }),
      current: staticOnScreen && st.sliceMode === 'brightness',
      icon: 'slice',
    },
    { id: 'graySweep', kind: 'video', label: t('sweep.gray'), detail: t('export.graySweepDetail', { axis }), duration: SWEEP_DURATION, icon: 'sweep' },
    { id: 'levelSweep', kind: 'video', label: t('sweep.level'), detail: t('export.levelSweepDetail', { axis }), duration: SWEEP_DURATION, icon: 'sweep' },
  ];
}
