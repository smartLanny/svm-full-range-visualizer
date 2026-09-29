// Domain types. Vocabulary follows CONTEXT.md.

/** One measured cell: a (gray level, brightness level) pair. */
export interface DataPoint {
  gray: number; // 0-255
  brightnessPercent: number; // 0-100
  nits: number; // measured luminance of this cell
  svm: number;
}

/** A raw measurement removed as an obvious anomaly (docs/adr/0012), kept for auditing. */
export interface ExcludedPoint extends DataPoint {
  /** Rule that removed it: belowNoise | duplicateColumn | duplicateRow | nitsShift | svmSpike. */
  reason: string;
  /** Human-readable explanation. */
  detail?: string;
}

/**
 * The on-disk / import-export JSON format ("dataset"). Kept backward compatible
 * with files exported by v1 of the app.
 */
export interface Dataset {
  id: string;
  name: string;
  data: DataPoint[];
  matrix: {
    rows: number[]; // gray levels (as measured, usually 255 -> 1)
    cols: number[]; // brightness percents (as measured, usually 100 -> 0)
    headerNits: number[]; // level luminance: nits at the max gray row, per column
    grid: (DataPoint | null)[][]; // grid[rowIndex][colIndex]; null = missing, never 0
  };
  color?: string;
  // Optional metadata written by v2 exports.
  device?: string;
  mode?: string;
  /** Raw points removed as obvious anomalies (their grid cells are null). */
  excluded?: ExcludedPoint[];
}

export type RecordSource = 'bundled' | 'user';

/** A dataset as held by the app: a Dataset plus device/mode identity. */
export interface SvmRecord extends Dataset {
  source: RecordSource;
  device: string;
  mode: string;
  /** Optional English display names (bundled records). */
  deviceEn?: string;
  modeEn?: string;
}

export type Lang = 'zh' | 'en';

export type MainTab = 'scene3d' | 'chart2d' | 'stats';

/** 3D terrain representation. */
export type Representation = 'surface' | 'bars';

/** Camera preset. 'top' = orthographic, heights flattened (heatmap). */
export type ViewPreset = 'perspective' | 'top' | 'front' | 'side';

/** What the 3D stage shows. */
export type SceneLayout = 'single' | 'sideBySide' | 'diff';

export type LightingMode = 'studio' | 'flat';

/** 2D cross-section mode. */
export type SliceMode = 'gray' | 'brightness';

/** 2D axis range mode. */
export type AxisMode = 'standard' | 'adaptive' | 'free';

/** Stage aspect used by presentation mode. 'fit' = fill the window. */
export type StageAspect = 'fit' | '16:9' | '9:16' | '1:1';

export enum ColormapType {
  TURBO = 'TURBO',
  JET = 'JET',
  RD_YL_BU = 'RD_YL_BU',
  RD_YL_BU_R = 'RD_YL_BU_R',
  PLASMA = 'PLASMA',
  VIRIDIS = 'VIRIDIS',
  INFERNO = 'INFERNO',
  MAGMA = 'MAGMA',
  TRAFFIC_LIGHT = 'TRAFFIC_LIGHT',
  COOL_WARM = 'COOL_WARM',
  RD_YL_BU_ENHANCED = 'RD_YL_BU_ENHANCED',
}

/** SVM reference thresholds, used app-wide. */
export const SVM_SAFE = 0.4;
export const SVM_CRITICAL = 1.0;
/** Contour levels drawn on terrain / heatmap. */
export const CONTOUR_LEVELS = [0.4, 1.0, 3.0] as const;
/** Default low-gray clip threshold (rows with gray < this are hidden when clipping). */
export const LOW_GRAY_CLIP = 15;
/** Default level-luminance cap for 3D / stats (columns with header nits above are hidden). */
export const DEFAULT_MAX_NITS = 500;
