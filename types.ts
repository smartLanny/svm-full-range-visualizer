
export interface DataPoint {
  gray: number; // 0-255
  brightnessPercent: number; // 0-100
  nits: number;
  svm: number;
}

export interface Dataset {
  id: string;
  name: string;
  data: DataPoint[];
  matrix: {
    rows: number[]; // Gray levels sorted
    cols: number[]; // Brightness percents sorted
    headerNits: number[]; // Nits values at max gray (255) for each column, used for X-axis alignment
    grid: (DataPoint | null)[][]; // grid[rowIndex][colIndex]
  };
  color: string;
}

export enum ViewStyle {
  SMOOTH = 'SMOOTH',
  BARS = 'BARS',
  FLAT = 'FLAT',
}

export enum CameraMode {
  ISO = 'ISO',
  HEATMAP = 'HEATMAP',
}

export enum LightingMode {
  STUDIO = 'STUDIO',
  FLAT = 'FLAT',
}

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
