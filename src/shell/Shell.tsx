import React, { useEffect, useSyncExternalStore } from 'react';
import { ArchiveRestore, FolderOpen, Plus, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { translate, useT } from '../i18n';
import { Button, Toaster, cn } from '../ui';
import Scene3DView from '../scene3d/Scene3DView';
import Chart2DView from '../chart2d/Chart2DView';
import StatsView from '../stats/StatsView';
import type { MainTab, StageAspect } from '../types';
import { Header } from './Header';
import { RecordsPanel } from './RecordsPanel';
import { InspectorBody, InspectorHeader, InspectorRail } from './Inspector';
import { Importer } from './Importer';
import { AboutDialog, ClearDataDialog, ShortcutsDialog } from './ShellDialogs';
import { DropOverlay } from './DropOverlay';
import { PresentationChrome } from './PresentationChrome';
import { usePresentationLifecycle } from './presentation';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { openJsonFiles } from './fileImport';
import { restoreBundled } from './actions';
import { INSPECTOR_DOCK_MIN, shellUi, useShellUi } from './uiStore';
import { Logo } from './Logo';

const subscribeResize = (fn: () => void) => {
  window.addEventListener('resize', fn);
  return () => window.removeEventListener('resize', fn);
};
function useWindowWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1600,
  );
}

const VIEWS: { id: MainTab; Component: React.ComponentType }[] = [
  { id: 'scene3d', Component: Scene3DView },
  { id: 'chart2d', Component: Chart2DView },
  { id: 'stats', Component: StatsView },
];

const RATIO: Record<Exclude<StageAspect, 'fit'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
};

/**
 * Root layout (docs/adr/0001, 0011): header / records panel / views / inspector, plus
 * presentation mode. The element tree around the views never changes shape, so switching
 * tabs or entering presentation never remounts a view (and never recreates a WebGL context).
 */
export function Shell() {
  const lang = useAppStore((s) => s.lang);
  const presenting = useAppStore((s) => s.presenting);
  const width = useWindowWidth();
  const docked = width >= INSPECTOR_DOCK_MIN;

  useGlobalShortcuts();
  usePresentationLifecycle();

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = translate(lang, 'common.appName');
  }, [lang]);

  return (
    <div className={cn('flex h-full flex-col bg-canvas', presenting && 'is-presenting')} data-testid="shell">
      {!presenting && <Header />}
      <div className="relative flex min-h-0 flex-1">
        {!presenting && <RecordsPanel />}
        <MainArea docked={docked} />
        {!presenting && docked && <DockedInspector />}
      </div>
      <PresentationChrome />
      <Importer />
      <ShortcutsDialog />
      <AboutDialog />
      <ClearDataDialog />
      <DropOverlay />
      {!presenting && <Toaster />}
    </div>
  );
}

function DockedInspector() {
  const open = useShellUi((s) => s.inspectorOpen);
  return (
    <aside
      data-testid="inspector"
      className={cn(
        'relative z-10 flex shrink-0 flex-col overflow-hidden border-l border-line bg-surface-1 transition-[width] duration-200 ease-out',
        open ? 'w-[300px]' : 'w-11',
      )}
    >
      {open ? (
        <div className="flex min-h-0 w-[300px] flex-1 flex-col">
          <InspectorHeader onClose={shellUi.toggleInspector} />
          <InspectorBody />
        </div>
      ) : (
        <InspectorRail onOpen={shellUi.toggleInspector} />
      )}
    </aside>
  );
}

function OverlayInspector() {
  const t = useT();
  const open = useShellUi((s) => s.inspectorOverlayOpen);
  if (!open)
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={<SlidersHorizontal size={14} />}
        className="absolute right-3 top-3 z-20 shadow-panel"
        title={t('shell.inspector.expand')}
        onClick={() => shellUi.setInspectorOverlay(true)}
        data-testid="inspector-toggle"
      >
        {t('shell.inspector.title')}
      </Button>
    );
  return (
    <aside
      data-testid="inspector"
      className="shell-drawer absolute bottom-0 right-0 top-0 z-20 flex w-[300px] flex-col border-l border-line bg-surface-1 shadow-panel"
    >
      <InspectorHeader overlay onClose={() => shellUi.setInspectorOverlay(false)} />
      <InspectorBody />
    </aside>
  );
}

function MainArea({ docked }: { docked: boolean }) {
  const tab = useAppStore((s) => s.tab);
  const presenting = useAppStore((s) => s.presenting);
  const presentBlack = useAppStore((s) => s.presentBlack);
  const stageAspect = useAppStore((s) => s.stageAspect);
  const ready = useAppStore((s) => s.ready);
  const empty = useAppStore((s) => s.ready && s.records.length === 0);

  const aspect: StageAspect = presenting ? stageAspect : 'fit';
  const boxed = aspect !== 'fit';
  const ratio = boxed ? RATIO[aspect] : 1;
  const stageStyle: React.CSSProperties = boxed
    ? {
        position: 'relative',
        width: `min(100vw, calc(100vh * ${ratio}))`,
        height: `min(100vh, calc(100vw / ${ratio}))`,
      }
    : { position: 'absolute', inset: 0 };

  return (
    <main className="relative min-w-0 flex-1 overflow-hidden" data-testid="main">
      {/* Stage: fills the area, or a centred fixed-aspect box with black bars in presentation. */}
      <div
        className={cn('absolute inset-0', boxed && 'flex items-center justify-center')}
        style={{
          background: presenting && (presentBlack || boxed) ? '#000' : undefined,
        }}
        data-testid="stage-outer"
      >
        <div style={stageStyle} className={cn('overflow-hidden', boxed && (presentBlack ? 'bg-black' : 'bg-canvas'))} data-testid="stage">
          {VIEWS.map(({ id, Component }) => {
            const active = tab === id;
            return (
              <div
                key={id}
                data-view={id}
                aria-hidden={!active}
                inert={!active}
                className="absolute inset-0"
                style={{
                  visibility: active ? 'visible' : 'hidden',
                  pointerEvents: active ? 'auto' : 'none',
                }}
              >
                <Component />
              </div>
            );
          })}
        </div>
      </div>
      {!ready && <LoadingState />}
      {empty && !presenting && <EmptyState />}
      {!presenting && !docked && <OverlayInspector />}
    </main>
  );
}

function LoadingState() {
  const t = useT();
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-canvas p-6" data-testid="loading" aria-busy="true">
      <div className="shell-skeleton h-4 w-56 rounded" />
      <div className="shell-skeleton mt-2 h-3 w-36 rounded" />
      <div className="shell-skeleton mt-6 flex-1 rounded-xl opacity-60" />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-3 rounded-full bg-surface-2/90 px-4 py-2 text-xs text-ink-2 shadow-panel ring-1 ring-line">
          <span className="shell-spinner" aria-hidden="true" />
          {t('shell.loading')}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas/95 p-6" data-testid="empty-state">
      <div className="flex max-w-md flex-col items-center text-center">
        <Logo size={56} className="opacity-90" />
        <h2 className="mt-5 text-base font-semibold text-ink-1">{t('shell.empty.title')}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t('shell.empty.body')}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => shellUi.openImporter('paste')} data-testid="empty-import">
            {t('shell.empty.import')}
          </Button>
          <Button variant="secondary" icon={<FolderOpen size={15} />} onClick={() => void openJsonFiles(t)}>
            {t('shell.empty.openJson')}
          </Button>
          <Button variant="ghost" icon={<ArchiveRestore size={15} />} onClick={() => void restoreBundled(t)}>
            {t('shell.empty.restore')}
          </Button>
        </div>
      </div>
    </div>
  );
}
