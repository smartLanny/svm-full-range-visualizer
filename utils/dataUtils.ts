import { Dataset, DataPoint } from '../types';

export const generateId = () => Math.random().toString(36).substr(2, 9);

export const COLORS = [
  '#3b82f6', // Blue
  '#ef4444', // Red
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#84cc16', // Lime
  '#d946ef', // Fuchsia
  '#6366f1', // Indigo
  '#14b8a6', // Teal
  '#e11d48', // Rose
  '#a855f7', // Purple
  '#fbbf24', // Amber-400
];

// Helper to get color for dataset
export const getDatasetColor = (index: number) => COLORS[index % COLORS.length];

export const getLogNits = (nits: number) => {
    // Log(0) is -infinity.
    // We visualize from 0 to 500.
    // Math.log10(x + 1) maps 0 -> 0, which is good for chart origins.
    return Math.log10(Math.max(0, nits) + 1);
};

export const downloadDatasetAsJson = (dataset: Dataset) => {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(dataset));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", `${dataset.name.replace(/\s+/g, '_')}_svm_data.json`);
  document.body.appendChild(downloadAnchorNode); // required for firefox
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
};

export const parseRawData = (raw: string, name: string, correctionFactor: number = 1.0): Dataset => {
  const lines = raw.trim().split('\n');
  if (lines.length < 2) throw new Error("Invalid data format: Too few lines");

  // 1. Find Header Line
  let headerLineIdx = -1;
  let brightnessCols: number[] = [];

  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    const tokens = line.split(/\t+/);
    
    // Check if this line looks like the header
    const potentialCols = tokens.map(t => {
        const val = parseFloat(t.replace('%', ''));
        return isNaN(val) ? null : val;
    }).filter((n): n is number => n !== null);

    if (potentialCols.length >= 3) {
        headerLineIdx = i;
        brightnessCols = potentialCols;
        break;
    }
  }

  if (headerLineIdx === -1) {
      throw new Error("Could not find a valid header row with brightness percentages.");
  }

  const grayRows: number[] = [];
  const grid: (DataPoint | null)[][] = [];

  // 2. Parse Data Rows
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const tokens = line.split(/\t+/);
    const grayLevel = parseInt(tokens[0], 10);
    if (isNaN(grayLevel)) continue;

    grayRows.push(grayLevel);
    const rowPoints: (DataPoint | null)[] = [];

    const dataTokensCount = tokens.length - 1;
    const isDualColMode = dataTokensCount >= brightnessCols.length * 1.5;

    for (let j = 0; j < brightnessCols.length; j++) {
      let nits = 0;
      let svm = 0;
      let valid = false;

      if (isDualColMode) {
          const nitsIdx = 1 + j * 2;
          const svmIdx = 1 + j * 2 + 1;
          
          if (nitsIdx < tokens.length && svmIdx < tokens.length) {
              const nitsRaw = parseFloat(tokens[nitsIdx]);
              const svmRaw = parseFloat(tokens[svmIdx]);
              if (!isNaN(nitsRaw) && !isNaN(svmRaw)) {
                  nits = nitsRaw;
                  svm = svmRaw;
                  valid = true;
              }
          }
      } else {
          const cellIdx = 1 + j;
          if (cellIdx < tokens.length) {
              const cellParts = tokens[cellIdx].trim().split(/\s+/);
              if (cellParts.length >= 2) {
                  const nitsRaw = parseFloat(cellParts[0]);
                  const svmRaw = parseFloat(cellParts[1]);
                  if (!isNaN(nitsRaw) && !isNaN(svmRaw)) {
                      nits = nitsRaw;
                      svm = svmRaw;
                      valid = true;
                  }
              }
          }
      }

      if (valid) {
          // Apply Correction Factor to Nits
          nits = nits * correctionFactor;

          const dp: DataPoint = {
            gray: grayLevel,
            brightnessPercent: brightnessCols[j],
            nits,
            svm
          };
          rowPoints.push(dp);
      } else {
          rowPoints.push(null);
      }
    }
    grid.push(rowPoints);
  }

  // 3. Extract Header Nits (Nits at Max Gray)
  let maxGrayIdx = 0;
  let maxGrayVal = -1;
  grayRows.forEach((g, idx) => {
      if (g > maxGrayVal) {
          maxGrayVal = g;
          maxGrayIdx = idx;
      }
  });

  const headerNits: number[] = [];
  for (let c = 0; c < brightnessCols.length; c++) {
      const p = grid[maxGrayIdx][c];
      headerNits.push(p ? p.nits : 0);
  }

  // 4. No Data Cleaning - Use Raw Data directly
  // We skip the regression step as requested.

  // Reconstruct flat data array
  const cleanData: DataPoint[] = [];
  for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
          if (grid[r][c]) {
              cleanData.push(grid[r][c]!);
          }
      }
  }

  return {
    id: generateId(),
    name: name || `Dataset ${new Date().toLocaleTimeString()}`,
    data: cleanData,
    matrix: {
      rows: grayRows,
      cols: brightnessCols,
      headerNits: headerNits,
      grid: grid
    },
    color: '#3b82f6'
  };
};