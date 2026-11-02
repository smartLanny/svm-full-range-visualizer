/**
 * Shapes of the migrated data files the page reads (data/uniformity/index.json,
 * data/reflectance/index.json, data/site-info.json). Only the fields the page uses are typed; the
 * files themselves are verbatim copies (data/README.md) and are never rewritten by the page.
 * The catalog and angle summary types live with the pipeline: db/catalog/types.ts.
 */

export interface UniformityLuminanceMetrics {
  typical: number;
  unit: string;
  ninePointUniformityPct: number;
  areaUniformityPct: number;
  deviation10PctArea: number;
}

export interface UniformityCctMetrics {
  typical: number;
  unit: string;
  ninePointSpreadK: number;
  areaSpreadK: number;
}

export interface UniformityMapInfo {
  asset: string;
  sourceKey: string;
  measurementSource?: string;
  measurementResolution?: [number, number];
  displayResolution?: [number, number];
  scale: {
    minPercentOfTypical?: number;
    maxPercentOfTypical?: number;
    minOffsetFromTypicalK?: number;
    maxOffsetFromTypicalK?: number;
  };
}

export interface UniformityCondition {
  id: string;
  label: string;
  pattern: string;
  referenceNits: number;
  /** Measured white (G255) at the same setting. Not in the data yet: future batches add it. */
  whiteMeasuredNits?: number | null;
  maps: Partial<Record<'luminance' | 'colorTemperature', UniformityMapInfo>>;
  metrics: { luminance?: UniformityLuminanceMetrics; colorTemperature?: UniformityCctMetrics };
}

export interface UniformityIndex {
  schemaVersion: number;
  colorStops: [number, [number, number, number]][];
  phones: { id: string; name: string; conditions: UniformityCondition[] }[];
}

export interface ReflectanceCurve {
  kind: 'total' | 'diffuse';
  label: string;
  method: string;
  samples: [number, number][];
  measuredAt?: string;
  instrument?: Record<string, string>;
}

export interface ReflectanceCondition {
  id: string;
  label: string;
  curves: { total?: ReflectanceCurve; diffuse?: ReflectanceCurve };
  measuredAt?: string;
}

export interface ReflectanceIndex {
  schemaVersion: number;
  wavelengthRangeNm: [number, number];
  phones: { id: string; name: string; conditions: ReflectanceCondition[] }[];
}

export interface SiteInfo {
  schemaVersion: 1;
  dataCommit: string | null;
  dataCommitDate: string | null;
  /** data/version.json verbatim (written by npm run db:import, pipeline/README.md). */
  version: { dataVersion?: string; date?: string; batch?: string | null } | null;
}
