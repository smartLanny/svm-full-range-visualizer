
import React, { useState, useRef } from 'react';
import Visualizer3D from './components/Visualizer3D';
import ComparisonChart from './components/ComparisonChart';
import DataImporter from './components/DataImporter';
import { downloadDatasetAsJson, COLORS } from './utils/dataUtils';
import { Dataset, ViewStyle, CameraMode, LightingMode, ColormapType } from './types';
import { Layers, Box, Eye, Sun, Plus, Trash2, Monitor, Download, FolderOpen, Cuboid, ChartLine, Maximize, ScanLine, Unlock, Scissors, Scan, Palette, Play, EyeOff, Flame } from 'lucide-react';

type ChartMode = 'standard' | 'adaptive' | 'free';

const App: React.FC = () => {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);
  
  // Layout State
  const [activeTab, setActiveTab] = useState<'3d' | '2d'>('3d');

  // View States
  const [viewStyle, setViewStyle] = useState<ViewStyle>(ViewStyle.SMOOTH);
  const [cameraMode, setCameraMode] = useState<CameraMode>(CameraMode.ISO);
  const [lighting, setLighting] = useState<LightingMode>(LightingMode.STUDIO);
  const [colormap, setColormap] = useState<ColormapType>(ColormapType.RD_YL_BU_ENHANCED);
  const [clipLowGray, setClipLowGray] = useState<boolean>(false);
  
  // Animation State
  const [isAnimating, setIsAnimating] = useState(false);
  const [isUIHidden, setIsUIHidden] = useState(false);
  
  // 2D View State
  const [targetGray, setTargetGray] = useState<number>(127);
  const [chartMode, setChartMode] = useState<ChartMode>('standard');

  const [isImporterOpen, setIsImporterOpen] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keyboard Listener for Esc to exit Hidden UI
  React.useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
              setIsUIHidden(false);
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Auto-load bundled measurement datasets from /datasets (served out of public/datasets).
  React.useEffect(() => {
      let cancelled = false;
      (async () => {
          const loaded: Dataset[] = [];
          let presets: string[] = [];
          try {
              const manifestResponse = await fetch('/datasets/manifest.json', { cache: 'no-store' });
              if (manifestResponse.ok) {
                  const manifest = await manifestResponse.json() as { file: string }[];
                  presets = manifest.map((item) => `/datasets/${item.file}`);
              }
          } catch (e) {
              console.warn('Dataset manifest failed to load:', e);
          }

          for (let i = 0; i < presets.length; i++) {
              try {
                  const res = await fetch(presets[i], { cache: 'no-store' });
                  if (!res.ok) continue;
                  const ds = (await res.json()) as Dataset;
                  if (!ds || !ds.data || !ds.matrix) continue;
                  loaded.push({
                      ...ds,
                      id: Math.random().toString(36).substr(2, 9),
                      color: ds.color || COLORS[i % COLORS.length],
                  });
              } catch (e) {
                  console.warn('Preset dataset failed to load:', presets[i], e);
              }
          }
          if (cancelled || loaded.length === 0) return;
          setDatasets(loaded);
          setActiveDatasetId(loaded[0].id);
      })();
      return () => { cancelled = true; };
  }, []);

  const handleImport = (ds: Dataset) => {
    // Assign color based on existing length
    const color = COLORS[datasets.length % COLORS.length];
    const newDs = { ...ds, color };
    setDatasets([...datasets, newDs]);
    if (!activeDatasetId) setActiveDatasetId(newDs.id);
  };

  const removeDataset = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSets = datasets.filter(d => d.id !== id);
    setDatasets(newSets);
    if (activeDatasetId === id) {
      setActiveDatasetId(newSets.length > 0 ? newSets[0].id : null);
    }
  };

  const saveDataset = (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const ds = datasets.find(d => d.id === id);
      if (ds) {
          downloadDatasetAsJson(ds);
      }
  };

  const triggerFileUpload = () => {
      fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
          try {
              const json = event.target?.result as string;
              const ds = JSON.parse(json) as Dataset;
              // Basic validation
              if (!ds.data || !ds.matrix || !ds.name) {
                  throw new Error("Invalid JSON format");
              }
              // Regenerate ID to avoid conflicts if re-importing same file
              const newDs = { ...ds, id: Math.random().toString(36).substr(2, 9) };
              handleImport(newDs);
          } catch (err) {
              alert("Failed to load file. It might be corrupted or not a valid dataset.");
          }
      };
      reader.readAsText(file);
      // Reset input
      e.target.value = '';
  };

  // Helper properties for chart
  const isChartAutoScale = chartMode === 'adaptive' || chartMode === 'free';
  const isChartYFixed = chartMode === 'standard' || chartMode === 'adaptive';

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-200 overflow-hidden font-sans">
      {/* Hidden File Input */}
      <input type="file" ref={fileInputRef} accept=".json" className="hidden" onChange={handleFileChange} />

      {/* Header */}
      {!isAnimating && !isUIHidden && (
      <header className="h-14 border-b border-slate-800 flex items-center px-4 bg-slate-900 shrink-0 z-10 justify-between">
        <div className="flex items-center gap-6">
            {/* Logo */}
            <div className="flex items-center gap-2">
                <Monitor className="text-blue-500" />
                <h1 className="font-bold text-lg tracking-wide text-white hidden md:block">SVM 3D Analyzer <span className="text-xs text-blue-400 font-normal px-1 border border-blue-900 bg-blue-900/30 rounded">PRO</span></h1>
            </div>

            {/* Tab Navigation */}
            <div className="flex bg-slate-800 p-1 rounded-lg">
                <button 
                    onClick={() => setActiveTab('3d')}
                    className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === '3d' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                >
                    <Cuboid size={16} /> 3D View
                </button>
                <button 
                    onClick={() => setActiveTab('2d')}
                    className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === '2d' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                >
                    <ChartLine size={16} /> 2D Analysis
                </button>
            </div>
        </div>

        {/* Right Side Controls (Context Aware) */}
        <div className="flex items-center gap-6">
           {activeTab === '3d' && (
               <>
                    {/* View Style */}
                    <div className="flex items-center bg-slate-800 rounded p-1">
                        <button 
                            onClick={() => setViewStyle(ViewStyle.SMOOTH)}
                            className={`flex items-center gap-2 px-3 py-1 rounded text-xs transition ${viewStyle === ViewStyle.SMOOTH ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                        >
                            <Layers size={14} /> Surface
                        </button>
                         <button 
                            onClick={() => setViewStyle(ViewStyle.FLAT)}
                            className={`flex items-center gap-2 px-3 py-1 rounded text-xs transition ${viewStyle === ViewStyle.FLAT ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                            title="Flat 2D Heatmap"
                        >
                            <Scan size={14} /> Flat
                        </button>
                        <button 
                            onClick={() => setViewStyle(ViewStyle.BARS)}
                            className={`flex items-center gap-2 px-3 py-1 rounded text-xs transition ${viewStyle === ViewStyle.BARS ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                        >
                            <Box size={14} /> Bars
                        </button>
                    </div>

                    {/* Colormap */}
                    <div className="flex items-center gap-2">
                        <Palette size={16} className="text-slate-400" />
                        <select 
                            value={colormap}
                            onChange={(e) => setColormap(e.target.value as ColormapType)}
                            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded p-1 outline-none focus:border-blue-500"
                        >
                            <option value={ColormapType.TRAFFIC_LIGHT}>Traffic Light (Green-Yellow-Red)</option>
                            <option value={ColormapType.RD_YL_BU_ENHANCED}>Enhanced RdYlBu (Recommended)</option>
                            <option value={ColormapType.COOL_WARM}>Cool-Warm (Blue-White-Red)</option>
                            <option value={ColormapType.MAGMA}>Magma (Inverted)</option>
                            <option value={ColormapType.TURBO}>Turbo</option>
                            <option value={ColormapType.VIRIDIS}>Viridis (Inverted)</option>
                            <option value={ColormapType.PLASMA}>Plasma (Inverted)</option>
                            <option value={ColormapType.INFERNO}>Inferno (Inverted)</option>
                            <option value={ColormapType.JET}>Jet (Legacy)</option>
                            <option value={ColormapType.RD_YL_BU}>RdYlBu (Diverging)</option>
                            <option value={ColormapType.RD_YL_BU_R}>RdYlBu_r (Diverging)</option>
                        </select>
                    </div>

                    {/* Clipping Toggle */}
                     <div className="flex items-center bg-slate-800 rounded p-1">
                        <button 
                            onClick={() => setClipLowGray(prev => !prev)}
                            className={`flex items-center gap-2 px-3 py-1 rounded text-xs transition ${clipLowGray ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                            title="Hide Gray Levels < 15"
                        >
                            <Scissors size={14} /> Clip &lt; 15
                        </button>
                    </div>

                    {/* Animation */}
                    <div className="flex items-center bg-slate-800 rounded p-1">
                        <button 
                            onClick={() => {
                                setViewStyle(ViewStyle.BARS);
                                setCameraMode(CameraMode.ISO);
                                setIsAnimating(true);
                            }}
                            className="flex items-center gap-2 px-3 py-1 rounded text-xs transition bg-blue-600 text-white shadow hover:bg-blue-500"
                            title="Play Intro Animation"
                        >
                            <Play size={14} /> Animate
                        </button>
                    </div>

                    {/* Camera Mode */}
                    <div className="flex items-center bg-slate-800 rounded p-1">
                        <button 
                            onClick={() => setCameraMode(CameraMode.ISO)}
                            className={`px-3 py-1 rounded text-xs transition ${cameraMode === CameraMode.ISO ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'}`}
                        >
                            ISO
                        </button>
                        <button 
                            onClick={() => setCameraMode(CameraMode.HEATMAP)}
                            className={`px-3 py-1 rounded text-xs transition ${cameraMode === CameraMode.HEATMAP ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'}`}
                        >
                            Heatmap
                        </button>
                    </div>

                    {/* Lighting */}
                    <div className="flex items-center gap-2 border-l border-slate-800 pl-4">
                        <button onClick={() => setLighting(l => l === LightingMode.STUDIO ? LightingMode.FLAT : LightingMode.STUDIO)} className="p-2 rounded hover:bg-slate-800 text-slate-300" title="Toggle Lighting">
                            {lighting === LightingMode.STUDIO ? <Sun size={18} /> : <Eye size={18} />}
                        </button>
                    </div>
               </>
           )}
           {activeTab === '2d' && (
               <div className="flex items-center bg-slate-800 rounded p-1">
                  <button 
                      onClick={() => setChartMode('standard')}
                      className={`flex items-center gap-2 px-3 py-1 rounded text-xs transition ${chartMode === 'standard' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                      title="Standard: Fixed 0-500 nits, Fixed 0-8 SVM"
                  >
                      <ScanLine size={14} /> Standard
                  </button>
                  <button 
                      onClick={() => setChartMode('adaptive')}
                      className={`flex items-center gap-2 px-3 py-1 rounded text-xs transition ${chartMode === 'adaptive' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                      title="Adaptive: Auto X-Axis, Fixed 0-8 SVM"
                  >
                      <Maximize size={14} /> Adaptive
                  </button>
                   <button 
                      onClick={() => setChartMode('free')}
                      className={`flex items-center gap-2 px-3 py-1 rounded text-xs transition ${chartMode === 'free' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                      title="Free: Auto X and Y Axes"
                  >
                      <Unlock size={14} /> Free
                  </button>
               </div>
           )}
           
           <div className="flex items-center border-l border-slate-800 pl-4 ml-2">
               <button 
                  onClick={() => setIsUIHidden(true)} 
                  className="p-2 rounded hover:bg-slate-800 text-slate-300 hover:text-white transition" 
                  title="Hide UI (Press Esc to restore)"
               >
                  <EyeOff size={18} />
               </button>
           </div>
        </div>
      </header>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar (Shared) */}
        {!isAnimating && !isUIHidden && (
        <div className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-800 flex justify-between items-center">
             <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Datasets</span>
             <div className="flex gap-1">
                 <button onClick={triggerFileUpload} className="p-1.5 bg-slate-700 hover:bg-slate-600 rounded text-slate-200 transition" title="Open JSON File">
                    <FolderOpen size={16} />
                 </button>
                 <button onClick={() => setIsImporterOpen(true)} className="p-1.5 bg-blue-600 hover:bg-blue-500 rounded text-white transition shadow-lg shadow-blue-900/20" title="Add New Data">
                   <Plus size={16} />
                 </button>
             </div>
          </div>
          
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {datasets.length === 0 && (
                <div className="text-center p-4 text-slate-600 text-sm italic border border-dashed border-slate-800 rounded m-2">
                    No data loaded.<br/>Click + to import.
                </div>
            )}
            {datasets.map(ds => (
              <div 
                key={ds.id}
                onClick={() => setActiveDatasetId(ds.id)}
                className={`group p-3 rounded-lg border cursor-pointer transition flex items-center justify-between
                  ${activeDatasetId === ds.id ? 'bg-blue-900/20 border-blue-500/50' : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'}
                `}
              >
                 <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-200 truncate">{ds.name}</div>
                    <div className="text-xs text-slate-500">{ds.data.length} pts</div>
                 </div>
                 <div className="flex gap-1">
                     <button
                        onClick={(e) => saveDataset(ds.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-blue-900/50 text-slate-500 hover:text-blue-400 rounded transition"
                        title="Save as JSON"
                        >
                        <Download size={14} />
                     </button>
                     <button 
                        onClick={(e) => removeDataset(ds.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-900/50 text-slate-500 hover:text-red-400 rounded transition"
                        title="Delete"
                     >
                        <Trash2 size={14} />
                     </button>
                 </div>
              </div>
            ))}
          </div>

          {/* 2D Slice Control - Always visible but most relevant for 2D tab */}
          <div className={`p-4 border-t border-slate-800 transition-colors ${activeTab === '2d' ? 'bg-blue-900/10' : 'bg-slate-800/50'}`}>
              <div className="mb-2 flex justify-between text-xs text-slate-400">
                  <span className={activeTab === '2d' ? 'text-blue-400 font-bold' : ''}>Cross-Section Gray</span>
                  <span>{targetGray}</span>
              </div>
              <input 
                 type="range" min="0" max="255" step="1"
                 value={targetGray}
                 onChange={e => setTargetGray(parseInt(e.target.value))}
                 className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
          </div>
        </div>
        )}

        {/* Viewports (Tabbed) */}
        <div className="flex-1 flex flex-col relative bg-slate-950">
           {activeTab === '3d' && (
               <div className="w-full h-full relative">
                    <Visualizer3D 
                        datasets={datasets}
                        activeDatasetId={activeDatasetId}
                        viewStyle={viewStyle}
                        cameraMode={cameraMode}
                        lighting={lighting}
                        clipLowGray={clipLowGray}
                        colormap={colormap}
                        isAnimating={isAnimating}
                        onAnimationEnd={() => {
                            setIsAnimating(false);
                            setViewStyle(ViewStyle.FLAT);
                            setCameraMode(CameraMode.HEATMAP);
                        }}
                    />
               </div>
           )}

           {activeTab === '2d' && (
               <div className="w-full h-full p-6">
                   {datasets.length > 0 ? (
                      <ComparisonChart 
                        datasets={datasets}
                        targetGray={targetGray}
                        autoScale={isChartAutoScale}
                        yFixed={isChartYFixed}
                      />
                   ) : (
                      <div className="h-full flex items-center justify-center text-slate-600 border border-slate-800 rounded-lg bg-slate-900/50">
                          <div className="text-center">
                            <p className="text-lg mb-2">No Data Selected</p>
                            <p className="text-sm">Import or select a dataset to view the analysis.</p>
                          </div>
                      </div>
                   )}
               </div>
           )}
        </div>
      </div>

      {isImporterOpen && (
        <DataImporter 
            onImport={handleImport}
            onClose={() => setIsImporterOpen(false)}
        />
      )}
    </div>
  );
};

export default App;
