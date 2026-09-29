import React from 'react';
import { useAppStore } from './store/appStore';
import { useT } from './i18n';
import { Segmented, Toaster } from './ui';
import Scene3DView from './scene3d/Scene3DView';
import Chart2DView from './chart2d/Chart2DView';
import StatsView from './stats/StatsView';
import ExportButton from './export/ExportButton';
import type { MainTab } from './types';

/** Minimal shell skeleton; replaced by the shell module (src/shell). */
export default function App() {
  const t = useT();
  const tab = useAppStore((s) => s.tab);
  const set = useAppStore((s) => s.set);
  const ready = useAppStore((s) => s.ready);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center justify-between border-b border-line bg-surface-1 px-4">
        <span className="text-sm font-semibold">{t('common.appName')}</span>
        <Segmented<MainTab>
          value={tab}
          onChange={(v) => set('tab', v)}
          options={[
            { value: 'scene3d', label: '3D' },
            { value: 'chart2d', label: '2D' },
            { value: 'stats', label: 'Stats' },
          ]}
        />
        <ExportButton />
      </header>
      <main className="min-h-0 flex-1">
        {!ready ? <div className="p-6 text-ink-3">{t('common.loading')}</div> : tab === 'scene3d' ? <Scene3DView /> : tab === 'chart2d' ? <Chart2DView /> : <StatsView />}
      </main>
      <Toaster />
    </div>
  );
}
