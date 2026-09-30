import React, { useState } from 'react';
import { ArchiveRestore, ChevronRight, Info, RotateCcw, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useT } from '../i18n';
import { Button, MenuItem, NumberInput, Segmented, Switch, cn, toast } from '../ui';
import { DEFAULT_MAX_NITS, type StageAspect } from '../types';
import {
  DEFAULT_SCENARIOS,
  isDefaultScenarios,
  SCENARIO_IDS,
  SCENARIO_NITS_CAP,
  SCENARIO_WEIGHT_MAX,
  validScenarios,
  weightShares,
  type ScenarioId,
  type ScenarioSpec,
} from '../data/scenarios';
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

/** 降噪 (docs/adr/0012 addendum): one persisted switch for every view (3D, 2D, stats, exports). */
export function DenoiseSwitch() {
  const t = useT();
  const denoise = useAppStore((s) => s.denoise);
  const set = useAppStore((s) => s.set);
  return <Switch checked={denoise} onChange={(v) => set('denoise', v)} label={t('common.denoise.title')} description={t('common.denoise.hint')} />;
}

/** Data-range controls shared by the settings popover and the inspector (with the denoise switch). */
export function DataRangeControls() {
  const t = useT();
  const clipLowGray = useAppStore((s) => s.clipLowGray);
  const maxNits = useAppStore((s) => s.maxNits);
  const set = useAppStore((s) => s.set);
  return (
    <>
      <DenoiseSwitch />
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

/** Round to 2 decimals (typed nits bounds). */
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Scenario reference configuration (docs/adr/0009 addendum): per scenario the level-luminance range
 * (≤ 500 nits), the gray range and the weight, with a reset. Collapsed by default. Every field only
 * accepts values that keep its scenario valid (min < max; weights not all 0), so the store never
 * holds a configuration sanitizeScenarios would reject.
 */
export function ScenarioSettings() {
  const t = useT();
  const scenarios = useAppStore((s) => s.scenarios);
  const set = useAppStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const shares = weightShares(scenarios);
  const isDefault = isDefaultScenarios(scenarios);
  const update = (id: ScenarioId, patch: Partial<ScenarioSpec>) => {
    const next = { ...scenarios, [id]: { ...scenarios[id], ...patch } };
    if (validScenarios(next)) set('scenarios', next);
  };
  const range = (lo: number, hi: number) => t('shell.settings.scRangeError', { lo, hi });
  return (
    <div className="border-b border-line px-3.5 py-3" data-testid="settings-scenarios">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span className="flex min-w-0 items-center gap-1 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3 group-hover:text-ink-2">
          <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
          <span className="truncate">{t('shell.settings.scenarios')}</span>
        </span>
        <span className={cn('shrink-0 text-2xs', isDefault ? 'text-ink-4' : 'text-accent-hover')}>{t(isDefault ? 'shell.settings.scDefault' : 'shell.settings.scCustom')}</span>
      </button>
      {open && (
        <div className="mt-2.5 flex flex-col gap-2">
          <p className="text-2xs leading-snug text-ink-3">{t('shell.settings.scenariosHint', { cap: SCENARIO_NITS_CAP })}</p>
          {SCENARIO_IDS.map((id) => {
            const sc = scenarios[id];
            const name = t(`stats.scenario.name.${id}`);
            const othersZero = SCENARIO_IDS.every((o) => o === id || scenarios[o].weight === 0);
            const wMin = othersZero ? 1 : 0;
            return (
              <div key={id} className="rounded-md bg-surface-2 px-2 py-1.5 ring-1 ring-inset ring-line">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-ink-1">{name}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-2xs text-ink-3">{t('shell.settings.scWeight')}</span>
                    <NumberInput
                      value={sc.weight}
                      min={wMin}
                      max={SCENARIO_WEIGHT_MAX}
                      step={5}
                      className="w-14"
                      aria-label={`${name} ${t('shell.settings.scWeight')}`}
                      errorText={t('shell.settings.scWeightError', { max: SCENARIO_WEIGHT_MAX })}
                      onChange={(v) => update(id, { weight: v })}
                    />
                    <span className="w-8 text-right text-2xs tabular-nums text-ink-3">{Math.round(shares[id] * 100)}%</span>
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-[2.25rem_minmax(0,1fr)_auto_minmax(0,1fr)_1.75rem] items-start gap-x-1 gap-y-1.5">
                  <span className="pt-1.5 text-2xs text-ink-3">{t('shell.settings.scNits')}</span>
                  <NumberInput
                    value={sc.nitsMin}
                    min={0.01}
                    max={r2(sc.nitsMax - 0.01)}
                    step={1}
                    aria-label={`${name} ${t('shell.settings.scNits')} min`}
                    errorText={range(0.01, r2(sc.nitsMax - 0.01))}
                    onChange={(v) => update(id, { nitsMin: v })}
                  />
                  <span className="pt-1.5 text-2xs text-ink-4">–</span>
                  <NumberInput
                    value={sc.nitsMax}
                    min={r2(sc.nitsMin + 0.01)}
                    max={SCENARIO_NITS_CAP}
                    step={10}
                    aria-label={`${name} ${t('shell.settings.scNits')} max`}
                    errorText={range(r2(sc.nitsMin + 0.01), SCENARIO_NITS_CAP)}
                    onChange={(v) => update(id, { nitsMax: v })}
                  />
                  <span className="pt-1.5 text-2xs text-ink-3">nits</span>
                  <span className="pt-1.5 text-2xs text-ink-3">{t('shell.settings.scGray')}</span>
                  <NumberInput
                    value={sc.grayMin}
                    min={0}
                    max={sc.grayMax - 1}
                    step={1}
                    aria-label={`${name} ${t('shell.settings.scGray')} min`}
                    errorText={range(0, sc.grayMax - 1)}
                    onChange={(v) => update(id, { grayMin: v })}
                  />
                  <span className="pt-1.5 text-2xs text-ink-4">–</span>
                  <NumberInput
                    value={sc.grayMax}
                    min={sc.grayMin + 1}
                    max={255}
                    step={1}
                    aria-label={`${name} ${t('shell.settings.scGray')} max`}
                    errorText={range(sc.grayMin + 1, 255)}
                    onChange={(v) => update(id, { grayMax: v })}
                  />
                  <span className="pt-1.5 text-2xs text-ink-3">G</span>
                </div>
              </div>
            );
          })}
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="ghost"
              icon={<RotateCcw size={12} />}
              disabled={isDefault}
              onClick={() => {
                set('scenarios', DEFAULT_SCENARIOS);
                toast(t('shell.settings.scResetDone'), 'success');
              }}
            >
              {t('shell.settings.scReset')}
            </Button>
          </div>
        </div>
      )}
    </div>
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
      <ScenarioSettings />
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
