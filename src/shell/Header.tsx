import React from 'react';
import { ChartColumn, ChartLine, Keyboard, Mountain, Play, Presentation, Settings2, Square } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useT } from '../i18n';
import { Button, Popover, Segmented, cn } from '../ui';
import { IconButton } from './IconBtn';
import ExportButton from '../export/ExportButton';
import type { Lang, MainTab } from '../types';
import { Logo } from './Logo';
import { SettingsPanel } from './SettingsPanel';
import { enterPresentation } from './presentation';
import { shellUi } from './uiStore';

const TAB_ICONS: Record<MainTab, React.ReactNode> = {
  scene3d: <Mountain size={15} strokeWidth={1.9} />,
  chart2d: <ChartLine size={15} strokeWidth={1.9} />,
  stats: <ChartColumn size={15} strokeWidth={1.9} />,
};
const TABS: MainTab[] = ['scene3d', 'chart2d', 'stats'];

export function Header() {
  const t = useT();
  const tab = useAppStore((s) => s.tab);
  const lang = useAppStore((s) => s.lang);
  const set = useAppStore((s) => s.set);
  const animating = useAppStore((s) => (tab === 'stats' ? false : s.animating[tab]));
  const requestPlay = useAppStore((s) => s.requestPlay);
  const requestStop = useAppStore((s) => s.requestStop);

  return (
    <header className="shell-header relative z-30 grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-line bg-surface-1 px-3">
      {/* Brand */}
      <div className="flex min-w-0 items-center gap-2.5 pl-1">
        <Logo size={24} className="shrink-0" />
        <span className="truncate text-[13px] font-semibold tracking-tight text-ink-1" title={t('common.appName')}>
          {t('common.appName')}
        </span>
        <span className="hidden shrink-0 rounded bg-surface-3 px-1.5 py-px font-mono text-[10px] text-ink-3 ring-1 ring-inset ring-line xl:inline">v2</span>
      </div>

      {/* Main tabs */}
      <nav role="tablist" aria-label={t('shell.tabs.aria')} className="flex items-center gap-0.5 rounded-lg bg-canvas/60 p-0.5 ring-1 ring-inset ring-line">
        {TABS.map((id, i) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`tab-${id}`}
              title={`${t(`shell.tabs.${id}`)} (${i + 1})`}
              onClick={() => set('tab', id)}
              className={cn(
                'relative inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-3.5 text-[13px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
                selected
                  ? 'bg-surface-3 text-ink-1 shadow-sm shadow-black/40 ring-1 ring-inset ring-line-strong'
                  : 'text-ink-3 hover:bg-surface-2 hover:text-ink-1',
              )}
            >
              <span className={cn('transition-colors', selected ? 'text-accent-hover' : 'text-current')}>{TAB_ICONS[id]}</span>
              {t(`shell.tabs.${id}`)}
            </button>
          );
        })}
      </nav>

      {/* Actions */}
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        {tab !== 'stats' &&
          (animating ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Square size={12} fill="currentColor" />}
              title={t('shell.header.stopHint')}
              onClick={() => requestStop(tab)}
              data-testid="header-stop"
            >
              <span className="hidden min-[1200px]:inline">{t('shell.header.stop')}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="subtle"
              icon={<Play size={13} fill="currentColor" />}
              title={t('shell.header.playHint')}
              onClick={() => requestPlay(tab)}
              data-testid="header-play"
            >
              <span className="hidden min-[1200px]:inline">{t('shell.header.play')}</span>
            </Button>
          ))}
        <Button
          size="sm"
          variant="secondary"
          icon={<Presentation size={14} />}
          title={t('shell.header.presentHint')}
          onClick={enterPresentation}
          data-testid="header-present"
        >
          <span className="hidden min-[1200px]:inline">{t('shell.header.present')}</span>
        </Button>
        <ExportButton />
        <div className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />
        <Segmented<Lang>
          aria-label={t('shell.header.lang')}
          value={lang}
          onChange={(v) => set('lang', v)}
          options={[
            { value: 'zh', label: '中', title: '中文' },
            { value: 'en', label: 'EN', title: 'English' },
          ]}
        />
        <Popover
          align="right"
          className="w-[300px] p-0"
          trigger={({ open, toggle }) => (
            <IconButton
              size="sm"
              label={t('shell.header.settings')}
              icon={<Settings2 size={15} />}
              active={open}
              onClick={toggle}
              data-testid="header-settings"
            />
          )}
        >
          {(close) => <SettingsPanel close={close} />}
        </Popover>
        <IconButton
          size="sm"
          label={t('shell.header.shortcuts')}
          icon={<Keyboard size={15} />}
          onClick={() => shellUi.setShortcuts(true)}
          data-testid="header-shortcuts"
        />
      </div>
    </header>
  );
}
