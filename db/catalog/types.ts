/**
 * Types of the screen database's generated files (data/devices.json, data/angle/summary.json).
 * The schema is described in data/README.md and enforced by pipeline/check.mjs (`npm run db:check`).
 */

export type DataType = 'svm' | 'angle' | 'uniformity' | 'reflectance';
export type StateKey =
  | 'default'
  | 'privacy'
  | 'privacy-film'
  | 'anti-reflective-film'
  | 'screen-protector'
  | 'unspecified'
  | 'inner'
  | 'outer';
export type StateBasis = 'source' | 'convention';
export type DisplayKey = 'main' | 'inner' | 'outer';
export type AvailabilityStatus = 'complete' | 'partial' | 'metrics-only' | 'pending-import' | 'not-measured';

export interface Label { zh: string; en: string; note?: string }

export interface Unit { id: string; panel: string | null; label: string | null; note?: string }

interface EntryBase {
  display: DisplayKey;
  state: StateKey;
  stateBasis: StateBasis;
  /** Physical sample; null unless the source confirms which one. */
  unit: string | null;
}

export interface SvmEntry extends EntryBase {
  /** File name in public/datasets (manifest.json `file`). */
  record: string;
  manifestDevice: string;
  /** Mode label verbatim from manifest.json. */
  mode: string;
  modeEn?: string;
  note?: string;
}

export interface AngleEntry extends EntryBase {
  /** Stable profile id of the standalone phone-view-angle-sim project (p0…, duo-inner, duo-outer). */
  profile: string;
  standaloneDevice: string;
  measured: boolean;
  status?: 'not-measured';
  substituteOf?: string;
  note?: string;
}

export interface UniformityEntry extends EntryBase {
  condition: '300' | '100' | '10';
  label: string;
  pattern: string;
  referenceNits: number;
  /** Assets are relative to data/uniformity/. */
  maps: { kind: 'luminance' | 'colorTemperature'; asset: string; sourceKey: string }[];
  metrics: ('luminance' | 'colorTemperature')[];
}

export interface ReflectanceEntry extends Omit<EntryBase, 'display'> {
  /** Condition id in data/reflectance/index.json. */
  condition: string;
  label: string;
  /** null: the source does not say which screen of a foldable was measured. */
  display: DisplayKey | null;
  panel?: string;
  /** UTC date of measuredAt (YYYY-MM-DD). */
  date: string;
  measuredAt: string;
  rawSampleId: string;
  sourceName: string;
}

export interface Availability { status: AvailabilityStatus; note?: string; sourceId?: string }

export interface Device {
  id: string;
  name: { zh: string; en: string };
  brand: string;
  aliases: string[];
  displays: DisplayKey[];
  units: Unit[];
  availability: Record<DataType, Availability>;
  svm: SvmEntry[];
  angle: AngleEntry[];
  uniformity: UniformityEntry[];
  reflectance: ReflectanceEntry[];
}

export interface Catalog {
  schemaVersion: 1;
  generatedBy: string;
  note: string;
  inputs: Record<string, string>;
  vocabulary: {
    dataTypes: Record<DataType, Label>;
    states: Record<StateKey, Label>;
    stateBasis: Record<StateBasis, Label>;
    displays: Record<DisplayKey, Label>;
    availability: Record<AvailabilityStatus, Label>;
  };
  brands: Record<string, { zh: string; en: string }>;
  counts: {
    devices: number;
    svmRecords: number;
    angleProfiles: number;
    angleProfilesMeasured: number;
    uniformityConditions: number;
    uniformityMaps: number;
    reflectanceSamples: number;
    devicesWith: Record<DataType, number>;
  };
  devices: Device[];
}

export interface AngleAtTheta { luminancePct: number; duv: number; jncd: number }

export interface AngleDirection {
  psiDeg: number;
  atTheta: Record<'30' | '45' | '60', AngleAtTheta>;
  /** null: luminance stays above half up to thetaMax (see halfLuminanceBeyondDeg). */
  halfLuminanceDeg: number | null;
  halfLuminanceBeyondDeg?: number;
}

export interface AngleProfileSummary {
  id: string;
  device: string;
  devIndexAtCommit: number;
  surface: 'inner' | 'outer' | null;
  privacy: boolean;
  privacyKind: 'mode' | 'film' | null;
  measured: boolean;
  sourceFiles: string[];
  azimuthsDeg: number[];
  standaloneSourceNote: string | null;
  standaloneMeasurement: Record<string, unknown> | null;
  thetaMaxDeg?: number;
  substituteOf?: string | null;
  setsIdenticalToSubstitute?: boolean | null;
  note?: string;
  metrics: {
    horizontal: { right: AngleDirection; left: AngleDirection };
    vertical: { up: AngleDirection; down: AngleDirection };
  } | null;
}

export interface AngleSummary {
  schemaVersion: 1;
  generatedBy: string;
  standalone: {
    repository: string;
    commit: string;
    commitDate: string;
    files: Record<string, string>;
    modelCall: string;
    devicesAtCommit: string[];
  };
  method: Record<string, unknown>;
  profiles: AngleProfileSummary[];
}
