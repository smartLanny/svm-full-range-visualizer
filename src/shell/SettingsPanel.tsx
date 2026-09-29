import React from 'react';
import { ArchiveRestore, Info, RotateCcw, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useT } from '../i18n';
import { MenuItem, Segmented, Switch, toast } from '../ui';
import { DEFAULT_MAX_NITS, type StageAspect } from '../types';
import { restoreBundled } from './actions';
import { shellUi } from './uiStore';

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line px-3.5 py-3 last:border-b-0">
      <div className="mb-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

/** Data-range controls shared by the settings popover and the inspector. */
export function DataRangeControls() {
  const t = useT();
  const clipLowGray = useAppStore((s) => s.clipLowGray);
  const maxNits = useAppStore((s) => s.maxNits);
  const set = useAppStore((s) => s.set);
  return (
    <>
      <Switch checked={clipLowGray} onChange={(v) => set('clipLowGray', v)} label={t('shell.inspector.clip')} description={t('shell.inspector.clipHint')} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-ink-1">{t('shell.inspector.cap')}</div>
          <div className="mt-0.5 text-2xs leading-snug text-ink-3">{t('shell.inspector.capHint')}</div>
        </div>
        <Segmented<'cap' | 'all'>
          aria-label={t('shell.inspector.cap')}
          value={maxNits === null ? 'all' : 'cap'}
          onChange={(v) => set('maxNits', v === 'all' ? null : DEFAULT_MAX_NITS)}
          options={[
            { value: 'cap', label: t('shell.inspector.cap500') },
            { value: 'all', label: t('shell.inspector.capAll') },
          ]}
        />
      </div>
    </>
  );
}

export function SettingsPanel({ close }: { close: () => void }) {
  const t = useT();
  const presentBlack = useAppStore((s) => s.presentBlack);
  const stageAspect = useAppStore((s) => s.stageAspect);
  const set = useAppStore((s) => s.set);
  const resetSettings = useAppStore((s) => s.resetSettings);

  return (
    <div className="flex max-h-[calc(100vh-72px)] flex-col overflow-y-auto" data-testid="settings-panel">
      <div className="border-b border-line px-3.5 py-2.5 text-xs font-semibold text-ink-1">{t('shell.settings.title')}</div>
      <Group title={t('shell.settings.data')}>
        <DataRangeControls />
      </Group>
      <Group title={t('shell.settings.presentation')}>
        <Switch
          checked={presentBlack}
          onChange={(v) => set('presentBlack', v)}
          label={t('shell.settings.presentBlack')}
          description={t('shell.settings.presentBlackHint')}
        />
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-ink-1">{t('shell.settings.aspect')}</div>
          <Segmented<StageAspect>
            fullWidth
            aria-label={t('shell.settings.aspect')}
            value={stageAspect}
            onChange={(v) => set('stageAspect', v)}
            options={[
              { value: 'fit', label: t('shell.settings.aspectFit') },
              { value: '16:9', label: '16:9' },
              { value: '9:16', label: '9:16' },
              { value: '1:1', label: '1:1' },
            ]}
          />
        </div>
      </Group>
      <div className="p-1.5">
        <MenuItem
          icon={<ArchiveRestore size={14} />}
          onClick={() => {
            close();
            void restoreBundled(t);
          }}
        >
          {t('shell.settings.restore')}
        </MenuItem>
        <MenuItem
          icon={<RotateCcw size={14} />}
          onClick={() => {
            resetSettings();
            toast(t('shell.settings.resetDone'), 'success');
          }}
        >
          {t('shell.settings.reset')}
        </MenuItem>
        <MenuItem
          icon={<Info size={14} />}
          onClick={() => {
            close();
            shellUi.setAbout(true);
          }}
        >
          {t('shell.settings.about')}
        </MenuItem>
        <div className="mx-2 my-1 h-px bg-line" />
        <MenuItem
          danger
          icon={<Trash2 size={14} className="text-red-300" />}
          onClick={() => {
            close();
            shellUi.setClear(true);
          }}
        >
          {t('shell.settings.clear')}
        </MenuItem>
      </div>
    </div>
  );
}
