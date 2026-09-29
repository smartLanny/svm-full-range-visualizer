import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts';
import { Dataset } from '../types';
import { Play, Pause, RefreshCw, Palette } from 'lucide-react';

interface Props {
  datasets: Dataset[];
  targetGray: number;
  autoScale: boolean; // Controls X-Axis: true = auto, false = fixed [0.01, 500]
  yFixed: boolean;    // Controls Y-Axis: true = [0, 8], false = auto
}

const NEON_COLORS = [
    '#38bdf8', // Sky Blue (Less harsh than Cyan)
    '#e879f9', // Soft Fuchsia
    '#4ade80', // Soft Green
    '#facc15', // Muted Yellow
    '#fb923c', // Soft Orange
    '#f87171', // Soft Red
    '#a78bfa', // Soft Violet
    '#2dd4bf', // Soft Teal
];

const ComparisonChart: React.FC<Props> = ({ datasets, targetGray, autoScale, yFixed }) => {
  // Track hidden datasets. New datasets are visible by default (not in this set).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [customColors, setCustomColors] = useState<Record<string, string>>({});
  const [lineTheme, setLineTheme] = useState<'adaptive' | 'original'>('adaptive');
  
  // Animation State
  const [isAnimating, setIsAnimating] = useState(false);
  const [animProgress, setAnimProgress] = useState(0); // 0 to 1
  const requestRef = useRef<number>();
  const startTimeRef = useRef<number>();

  const toggleDataset = (id: string) => {
    setHiddenIds(prev => {
        const next = new Set(prev);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        return next;
    });
  };

  const startAnimation = () => {
      setIsAnimating(true);
      setAnimProgress(0);
      startTimeRef.current = performance.now();
  };

  const stopAnimation = () => {
      setIsAnimating(false);
      setAnimProgress(0);
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
  };

  useEffect(() => {
      if (isAnimating) {
          const animate = (time: number) => {
              if (!startTimeRef.current) startTimeRef.current = time;
              const elapsed = time - startTimeRef.current;
              const duration = 10000; // 10 seconds for slower transition
              
              const rawProgress = Math.min(elapsed / duration, 1);
              // Ease in-out
              const ease = rawProgress < 0.5 ? 2 * rawProgress * rawProgress : -1 + (4 - 2 * rawProgress) * rawProgress;
              
              setAnimProgress(ease);

              if (rawProgress < 1) {
                  requestRef.current = requestAnimationFrame(animate);
              } else {
                  setIsAnimating(false);
              }
          };
          requestRef.current = requestAnimationFrame(animate);
      }
      return () => {
          if (requestRef.current) cancelAnimationFrame(requestRef.current);
      };
  }, [isAnimating]);
  
  const effectiveGray = isAnimating ? (255 - (205 * animProgress)) : targetGray;
  const displayGray = Math.round(effectiveGray);

  // 1. Prepare Base Data (Points only) - Stable when color changes
  const pointsData = useMemo(() => {
    return datasets.map((ds) => {
      let points: {x: number, y: number}[] = [];
      
      // Create a sorted mapping of rows to grid indices
      const sortedRows = ds.matrix.rows
        .map((val, idx) => ({ val, idx }))
        .sort((a, b) => a.val - b.val);

      if (sortedRows.length === 0) return { id: ds.id, name: ds.name, points: [] };

      // Find bounding rows for interpolation
      let lowNode = sortedRows[0];
      let highNode = sortedRows[sortedRows.length - 1];

      // Clamp effectiveGray within range
      const clampedGray = Math.max(sortedRows[0].val, Math.min(sortedRows[sortedRows.length - 1].val, effectiveGray));

      for (let i = 0; i < sortedRows.length - 1; i++) {
          if (clampedGray >= sortedRows[i].val && clampedGray <= sortedRows[i+1].val) {
              lowNode = sortedRows[i];
              highNode = sortedRows[i+1];
              break;
          }
      }

      // Calculate interpolation factor t (0 to 1)
      const range = highNode.val - lowNode.val;
      const t = range === 0 ? 0 : (clampedGray - lowNode.val) / range;

      // Interpolate each column
      ds.matrix.cols.forEach((_, colIdx) => {
          const pLow = ds.matrix.grid[lowNode.idx][colIdx];
          const pHigh = ds.matrix.grid[highNode.idx][colIdx];

          if (pLow && pHigh) {
              // Linear Interpolation
              const nits = pLow.nits + (pHigh.nits - pLow.nits) * t;
              const svm = pLow.svm + (pHigh.svm - pLow.svm) * t;

              // Strict check: Only add point if interpolated Nits <= 500
              // AND ensure we respect the physical limit of the interpolated line.
              // If pLow or pHigh was the last point in their respective rows,
              // the interpolated point should naturally be the last point.
              // We do NOT extend beyond the available column data.
              
              if (nits > 0 && nits <= 500) {
                  points.push({ x: nits, y: svm });
              }
          } else if (pLow && t < 0.001) {
              // Very close to Low Node
              if (pLow.nits > 0 && pLow.nits <= 500) points.push({ x: pLow.nits, y: pLow.svm });
          } else if (pHigh && t > 0.999) {
               // Very close to High Node
              if (pHigh.nits > 0 && pHigh.nits <= 500) points.push({ x: pHigh.nits, y: pHigh.svm });
          }
          // If one is missing and we are in the middle (t ~ 0.5), it means one gray level has data for this column (brightness %)
          // and the other doesn't. This usually happens at the tail end of the curve (highest brightness).
          // In this case, we STOP interpolating. We do NOT extend.
          // This ensures that if G100 ends at 50 nits, and G101 ends at 51 nits,
          // the interpolated G100.5 will end around 50.5 nits, and NOT continue to 500.
      });

      points.sort((a, b) => a.x - b.x);

      return {
        id: ds.id,
        name: ds.name,
        points
      };
    });
  }, [datasets, effectiveGray]);

  // 2. Merge with Colors - Updates cheaply when color changes
  const chartData = useMemo(() => {
      return pointsData.map((series, index) => {
        // Determine color
        const originalColor = datasets.find(d => d.id === series.id)?.color || '#fff';
        let displayColor = customColors[series.id] || originalColor;
        
        if (!customColors[series.id] && lineTheme === 'adaptive') {
            displayColor = NEON_COLORS[index % NEON_COLORS.length];
        }

        return {
            ...series,
            color: displayColor
        };
      });
  }, [pointsData, datasets, customColors, lineTheme]);

  // Interpolation Helper
  const getInterpolatedValue = (points: {x: number, y: number}[], targetX: number) => {
      if (points.length === 0) return null;
      if (targetX <= points[0].x) return points[0].y;
      if (targetX >= points[points.length - 1].x) return points[points.length - 1].y;
      
      for (let i = 0; i < points.length - 1; i++) {
          if (targetX >= points[i].x && targetX <= points[i+1].x) {
              const x0 = points[i].x;
              const x1 = points[i+1].x;
              const y0 = points[i].y;
              const y1 = points[i+1].y;
              if (x1 - x0 === 0) return y0;
              return y0 + (targetX - x0) * (y1 - y0) / (x1 - x0);
          }
      }
      return null;
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && label) {
      const targetX = Number(label);
      
      // Calculate interpolated values for ALL visible datasets
      const rows = datasets
        .filter(ds => !hiddenIds.has(ds.id))
        .map(ds => {
             const series = chartData.find(s => s.id === ds.id);
             if (!series) return null;
             const val = getInterpolatedValue(series.points, targetX);
             return { name: ds.name, color: series.color, value: val, id: ds.id };
        })
        .filter(r => r && r.value !== null)
        .sort((a, b) => (b!.value as number) - (a!.value as number));

      return (
        <div className="bg-black/90 border border-slate-600 p-4 rounded shadow-2xl text-sm z-50 backdrop-blur-md">
          <p className="font-mono font-bold text-slate-300 border-b border-slate-600 pb-2 mb-2">
              Nits: {targetX.toFixed(3)}
          </p>
          <div className="flex flex-col gap-2">
            {rows.map((r: any) => (
              <div key={r.id} className="flex items-center justify-between gap-6">
                  <span style={{ color: r.color }} className="font-bold text-base">{r.name}:</span>
                  <span className="font-mono text-white text-base">
                      {r.value.toFixed(3)}
                  </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full h-full bg-black border border-slate-800 rounded-xl p-6 flex flex-col relative group">
      {/* Header Section */}
      <div className="flex flex-col items-center mb-6 relative z-20">
          <h1 className="text-3xl font-bold text-white mb-2 tracking-wide">
              SVM测试（灰阶G{displayGray}）
          </h1>
          <div className="flex items-center gap-4 text-slate-400 text-sm">
             <span>Y-Axis: {yFixed ? 'Fixed [0-6]' : 'Auto'}</span>
             <span>|</span>
             <span>X-Axis: {autoScale ? 'Auto' : 'Fixed [0-500]'}</span>
          </div>
          
          {/* Animation Controls */}
          <div className="absolute right-0 top-0 flex items-center gap-2">
             <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-700">
                <button 
                    onClick={() => setLineTheme(prev => prev === 'adaptive' ? 'original' : 'adaptive')}
                    className={`p-2 rounded flex items-center gap-2 text-xs font-medium transition-colors ${lineTheme === 'adaptive' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
                    title="Toggle Color Theme"
                >
                    <Palette size={16} />
                    {lineTheme === 'adaptive' ? 'Neon' : 'Original'}
                </button>
             </div>

             <button
                onClick={isAnimating ? stopAnimation : startAnimation}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm transition-all ${
                    isAnimating 
                    ? 'bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30' 
                    : 'bg-blue-500/20 text-blue-400 border border-blue-500/50 hover:bg-blue-500/30'
                }`}
             >
                {isAnimating ? <Pause size={16} /> : <Play size={16} />}
                {isAnimating ? 'Stop Demo' : 'G255→G50 Anim'}
             </button>
          </div>
      </div>

      {/* Custom Legend / Control Panel (Enlarged) */}
      <div className="absolute top-24 right-14 z-10 bg-black/80 border border-slate-700 rounded-xl p-5 shadow-2xl backdrop-blur-md max-h-[400px] overflow-y-auto min-w-[280px]">
          <div className="text-sm font-bold text-slate-300 mb-3 px-1 uppercase tracking-wider">Datasets</div>
          <div className="flex flex-col gap-2">
              {chartData
                  .sort((a, b) => {
                      const aHidden = hiddenIds.has(a.id) ? 1 : 0;
                      const bHidden = hiddenIds.has(b.id) ? 1 : 0;
                      return aHidden - bHidden;
                  })
                  .map(ds => {
                  const isHidden = hiddenIds.has(ds.id);
                  return (
                      <div 
                        key={ds.id} 
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${isHidden ? 'opacity-40 hover:bg-slate-800' : 'bg-slate-900/50 hover:bg-slate-800 border border-slate-800'}`}
                      >
                          {/* Color Picker Wrapper */}
                          <div 
                            className="relative w-5 h-5 flex-shrink-0 group/color"
                            onClick={(e) => e.stopPropagation()}
                          >
                              <input 
                                  key={ds.color} // Remount input when external color changes
                                  type="color" 
                                  defaultValue={ds.color} 
                                  onBlur={(e) => setCustomColors(prev => ({ ...prev, [ds.id]: e.target.value }))}
                                  className="opacity-0 absolute inset-0 w-full h-full cursor-pointer z-20"
                              />
                              <div 
                                className={`absolute inset-0 w-full h-full rounded shadow-sm flex items-center justify-center border transition-transform group-hover/color:scale-110 z-10 ${isHidden ? 'border-slate-500 bg-transparent' : 'border-transparent'}`} 
                                style={{ backgroundColor: isHidden ? 'transparent' : ds.color }}
                              >
                                   {isHidden && <div className="w-2 h-2 bg-slate-500 rounded-full" />}
                              </div>
                          </div>

                          {/* Label (Click to toggle visibility) */}
                          <span 
                            className={`text-sm font-medium whitespace-nowrap cursor-pointer flex-1 select-none ${isHidden ? 'text-slate-500 line-through' : 'text-slate-200'}`}
                            onClick={() => toggleDataset(ds.id)}
                          >
                              {ds.name}
                          </span>
                      </div>
                  );
              })}
          </div>
      </div>

      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
            <LineChart margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
            <XAxis 
                type="number" 
                dataKey="x" 
                name="Nits" 
                scale="log" 
                domain={[autoScale ? (min: number) => min * 0.8 : 0.01, 500]} 
                stroke="#64748b"
                tick={{ fill: '#94a3b8', fontSize: 12 }}
                tickFormatter={(tick) => {
                    if (tick < 0.1) return tick.toFixed(3);
                    if (tick < 1) return tick.toFixed(2);
                    return tick.toString();
                }}
                allowDataOverflow={true} 
                ticks={[0.01, 0.1, 1, 10, 100, 500]} 
            />
            <YAxis 
                stroke="#64748b" 
                tick={{ fill: '#94a3b8', fontSize: 12 }}
                label={{ value: 'SVM', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 14, fontWeight: 'bold' }} 
                domain={yFixed ? [0, 6] : ([dataMin, dataMax]: [number, number]) => {
                    const range = dataMax - dataMin;
                    const padding = range > 0 ? range * 0.1 : 0.1;
                    return [dataMin - padding, dataMax + padding];
                }}
                allowDataOverflow={true}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#facc15', strokeWidth: 2, strokeDasharray: '4 4' }} />
            
            <ReferenceLine y={0.4} stroke="#22c55e" strokeDasharray="3 3" strokeWidth={2} label={{ position: 'right', value: '0.4 (Safe)', fill: '#22c55e', fontSize: 12, fontWeight: 'bold' }} />
            <ReferenceLine y={1.0} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={2} label={{ position: 'right', value: '1.0 (Critical)', fill: '#ef4444', fontSize: 12, fontWeight: 'bold' }} />

            {chartData.map((series) => {
                if (hiddenIds.has(series.id)) return null;
                return (
                    <Line
                    key={series.id}
                    data={series.points}
                    type="monotone"
                    dataKey="y"
                    name={series.name}
                    stroke={series.color}
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 6, strokeWidth: 0, fill: '#fff' }}
                    connectNulls
                    isAnimationActive={false} 
                    animationDuration={300}
                    />
                );
            })}
            </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default ComparisonChart;