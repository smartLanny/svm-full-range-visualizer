import React, { useState } from 'react';
import { parseRawData } from '../utils/dataUtils';
import { Dataset } from '../types';
import { Upload, X } from 'lucide-react';

interface Props {
  onImport: (dataset: Dataset) => void;
  onClose: () => void;
}

const EXAMPLE_DATA = `标准120Hz																																				
亮度条百分比	100		90		80		70		60		50		40		30		27		25		22		20		16		13		10		6		4		0	
灰阶 (Gray)	亮度 (Mean Raw)	SVM 值	亮度 (Mean Raw)	SVM 值	亮度（Mean Raw）	SVM值	亮度 (Mean Raw)	SVM 值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值	亮度 (Mean Raw)	SVM值
255	804.15	0.052	660.98	0.055	525.41	0.059	405.07	0.065	298.9	0.073	205.6	0.089	126.6	0.118	59.36	0.14	40.56	0.221	30.03	0.285	19.69	0.322	14.31	0.283	9.47	0.228	5.61	0.334	3.83	0.588	2.63	1.045	2.11	1.351	1.72	1.665
233	649.43	0.055	533.47	0.059	429.78	0.064	328.16	0.071	239.83	0.082	165.39	0.101	102.15	0.136	47.83	0.175	29.32	0.294	21.21	0.386	17.4	0.379	10.03	0.468	6.73	0.441	3.88	0.626	2.72	0.999	1.98	1.454	1.69	1.696	1.41	2.01
212	533.27	0.059	431.41	0.063	343.71	0.07	264.17	0.078	193.08	0.092	133.22	0.115	82.41	0.158	38.22	0.216	23.15	0.36	16.78	0.474	12.85	0.498	7.77	0.627	5.22	0.644	2.98	0.923	2.08	1.381	1.58	1.807	1.38	2.03	1.16	2.316
192	423.54	0.064	346.98	0.069	277.14	0.077	212.32	0.088	154.95	0.105	107.16	0.133	66.14	0.185	31.04	0.267	18.49	0.435	13.01	0.576	9.32	0.669	6.04	0.804	4.08	0.872	2.32	1.253	1.65	1.741	1.28	2.149	1.14	2.33	0.97	2.619
174	337.13	0.07	279.77	0.077	220.97	0.087	169.07	0.101	122.74	0.122	85.07	0.155	52.78	0.216	24.55	0.327	15.51	0.502	10.94	0.659	7.09	0.832	5.1	0.934	3.49	1.033	1.97	1.486	1.43	1.975	1.06	2.466	0.96	2.64	0.78	2.931
156	267.46	0.079	218.59	0.087	174.67	0.1	133.32	0.117	97.09	0.143	67.03	0.184	41.77	0.256	19.49	0.401	12.59	0.6	9.16	0.752	5.66	0.986	4.29	1.083	2.91	1.238	1.7	1.712	1.24	2.215	0.86	2.797	0.75	2.97	0.62	3.239
139	205.99	0.091	167.75	0.102	134.42	0.118	102.28	0.14	74.25	0.172	51.15	0.224	31.91	0.312	15.06	0.501	9.7	0.722	7.28	0.889	4.44	1.177	3.42	1.296	2.32	1.519	1.39	2.025	1.02	2.525	0.67	3.12	0.6	3.263	0.48	3.546
124	160.07	0.106	130.47	0.12	107.14	0.139	82.04	0.166	57.35	0.208	39.72	0.268	24.83	0.376	11.67	0.613	7.79	0.848	5.98	1.018	3.48	1.387	2.81	1.501	1.93	1.759	1.17	2.295	0.84	2.807	0.55	3.377	0.48	3.579	0.38	3.816
109	122	0.127	99.35	0.144	79.51	0.168	62.24	0.202	43.69	0.254	30.41	0.326	19.04	0.453	10.21	0.681	6.21	0.997	4.78	1.189	2.73	1.664	2.25	1.764	1.54	2.075	0.97	2.649	0.87	2.757	0.46	3.653	0.36	3.88	0.29	4.113
96	93.34	0.153	76.09	0.174	60.63	0.204	46.01	0.247	33.93	0.309	23.23	0.396	14.53	0.551	6.69	0.937	4.83	1.193	3.78	1.402	2.08	1.975	1.78	2.059	1.22	2.42	0.76	2.97	0.53	3.437	0.36	3.899	0.28	4.136	0.23	4.31
83	67.03	0.193	54.47	0.222	43.46	0.26	33.02	0.315	24.07	0.392	16.77	0.503	10.5	0.694	4.78	1.193	3.57	1.496	2.71	1.733	1.54	2.308	1.36	2.445	0.94	2.837	0.57	3.35	0.39	3.756	0.27	4.193	0.21	4.371	0.17	4.548
71	47.3	0.248	38.58	0.285	30.8	0.335	23.79	0.404	17.09	0.501	11.84	0.643	7.45	0.88	3.37	1.504	2.52	1.848	1.91	2.129	1.16	2.658	0.94	2.892	0.65	3.265	0.39	3.761	0.28	4.126	0.19	4.463	0.15	4.607	0.12	4.742
60	32.96	0.324	27.18	0.375	21.52	0.437	16.39	0.523	11.92	0.652	8.31	0.824	5.33	1.121	2.35	1.86	1.71	2.242	1.33	2.548	0.82	3.061	0.64	3.33	0.46	3.697	0.27	4.159	0.19	4.405	0.13	4.782	0.1	4.911	0.08	4.9
51	22.88	0.425	18.61	0.488	14.9	0.57	11.33	0.684	8.28	0.842	5.75	1.06	3.61	1.432	1.68	2.248	1.2	2.646	0.93	2.968	0.58	3.464	0.45	3.722	0.31	4.018	0.2	4.364	0.14	4.631	0.09	4.849	0.07	4.942	0.06	4.909
42	14.47	0.592	11.81	0.677	9.46	0.788	7.19	0.941	5.26	1.15	3.66	1.423	2.31	1.875	1.18	2.73	0.82	3.112	0.63	3.454	0.4	3.89	0.3	4.128	0.2	4.426	0.13	4.679	0.09	4.846	0.06	5.102	0.05	4.928	0.04	5.1
34	9.34	0.815	7.57	0.927	6.19	1.067	4.64	1.261	3.39	1.523	2.37	1.864	1.49	2.395	0.91	3.064	0.61	3.45	0.45	3.782	0.3	4.145	0.19	4.506	0.13	4.714	0.08	4.879	0.06	4.997	0.04	5.085	0.04	5.114	0.02	5.15
27	5.61	1.152	4.58	1.303	3.66	1.491	2.8	1.739	2.1	2.058	1.44	2.458	0.91	3.031	0.64	3.509	0.43	3.873	0.32	4.144	0.21	4.45	0.13	4.731	0.09	4.797	0.06	4.887	0.04	5.224	0.02	5.153	0.02	5.455	0.01	4.735
21	3.13	1.675	2.61	1.888	2.04	2.121	1.57	2.417	1.17	2.761	0.83	3.188	0.52	3.751	0.44	3.825	0.32	4.133	0.25	4.345	0.16	4.652	0.11	4.793	0.08	4.95	0.05	4.911	0.03	5.323	0.02	4.848	0.02	5.521	0.01	6.37
15	1.48	2.582	1.19	2.842	0.94	3.151	0.97	3.224	0.56	3.744	0.4	4.086	0.26	4.462	0.35	4.193	0.21	4.532	0.16	4.679	0.1	4.894	0.07	4.987	0.05	4.934	0.03	5.305	0.02	5.475	0.01	5.147	0.01	5.129	0.01	5.102
11	0.74	3.524	0.63	3.751	0.49	3.996	0.39	4.211	0.3	4.433	0.21	4.689	0.14	4.94	0.19	4.598	0.14	4.764	0.1	4.95	0.06	5.062	0.04	5.266	0.03	4.907	0.02	4.773	0.01	5.117	0.01	6.003	0.01	5.104	0	6.349
7	0.25	4.733	0.21	4.856	0.17	5.022	0.14	5.048	0.1	5.241	0.07	5.382	0.05	5.418	0.06	5.145	0.04	5.287	0.03	5.537	0.02	5.57	0.01	5.739	0.01	5.08	0.01	3.603	0	4.888	0	4.783	0	3.548	0	3.314
5	0.08	5.317	0.06	5.399	0.05	5.406	0.04	5.469	0.03	5.304	0.01	6.501	0.01	5.66	0.02	5.123	0.01	5.436	0.01	6.059	0.01	6.21	0	6.55	0	4.913	0	4.757	0	4.369	0	0.196	0	1.034	0	0.213
2	0	0.133	0	2.38	0	10.715	0	2.837	0	1.949	0	2.576	0	0.291	0	3.257	0	0.252	0	0.242	0	1.096	0	1.267	0	1.013	0	1.135	0	0.307	0	0.33	0	1.034	0	0.119
1	0	0.23	0	3.113	0	0.257	0	3.092	0	0.218	0	0.221	0	2.364	0	4.894	0	0.267	0	0.271	0	0.956	0	0.318	0	0.309	0	0.201	0	0.335	0	0.289	0	1.092	0	0.33`;

const DataImporter: React.FC<Props> = ({ onImport, onClose }) => {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [correctionFactor, setCorrectionFactor] = useState(1.0);
  const [error, setError] = useState<string | null>(null);

  const handleImport = () => {
    try {
      setError(null);
      const validFactor = isNaN(correctionFactor) ? 1.0 : correctionFactor;
      const dataset = parseRawData(text, name, validFactor);
      onImport(dataset);
      onClose();
    } catch (e: any) {
      setError(e.message || "Failed to parse data");
    }
  };

  const loadExample = () => {
     setText(EXAMPLE_DATA);
     setName("Standard 120Hz Demo");
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="bg-slate-800 rounded-xl shadow-2xl w-[600px] max-h-[90vh] flex flex-col border border-slate-700">
        <div className="p-4 border-b border-slate-700 flex justify-between items-center">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Upload size={20} /> Import Dataset
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>
        
        <div className="p-6 flex-1 overflow-auto">
          <div className="mb-4">
            <label className="block text-slate-400 text-sm mb-1">Dataset Name</label>
            <input 
              type="text" 
              className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="e.g. iPhone 15 Pro Max 120Hz"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          
          <div className="mb-4">
             <label className="block text-slate-400 text-sm mb-1">Brightness Correction Factor (e.g. 0.9)</label>
             <input 
               type="number" 
               step="0.01"
               className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white focus:ring-2 focus:ring-blue-500 outline-none"
               placeholder="1.0"
               value={correctionFactor}
               onChange={e => setCorrectionFactor(parseFloat(e.target.value))}
             />
             <p className="text-xs text-slate-500 mt-1">All brightness (nits) values will be multiplied by this factor.</p>
          </div>
          
          <div className="mb-4">
             <div className="flex justify-between mb-1">
                <label className="block text-slate-400 text-sm">Paste Data (Excel/TSV)</label>
                <button onClick={loadExample} className="text-xs text-blue-400 hover:text-blue-300 underline">Load Example Format</button>
             </div>
             <p className="text-xs text-slate-500 mb-2">Support formats: Tab-separated (Excel). Headers required.</p>
            <textarea 
              className="w-full h-64 bg-slate-900 border border-slate-700 rounded p-2 text-xs font-mono text-slate-300 focus:ring-2 focus:ring-blue-500 outline-none whitespace-pre"
              placeholder={`Paste your data here...`}
              value={text}
              onChange={e => setText(e.target.value)}
            />
          </div>

          {error && (
            <div className="bg-red-900/50 border border-red-500 text-red-200 p-3 rounded text-sm mb-4">
              {error}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-slate-300 hover:bg-slate-700 rounded transition">Cancel</button>
          <button onClick={handleImport} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium shadow-lg transition">
            Import Data
          </button>
        </div>
      </div>
    </div>
  );
};

export default DataImporter;