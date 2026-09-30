import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ClipboardPaste, FileJson, FileUp, RotateCcw, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useLang, useT, type TFunction } from '../i18n';
import { parseRawData, splitTables } from '../data/parse';
import { guessDeviceMode, recordLabel, toRecord } from '../data/records';
import { EXAMPLE_TSV } from '../data/exampleTsv';
import type { Dataset } from '../types';
import { useAppStore } from '../store/appStore';
import * as THREE from 'three';
import { getJsColor } from '../colormaps';
import { Button, Dialog, NumberInput, Segmented, cn, toast } from '../ui';
import { FormRow, TextInput, useFieldId } from './controls';
import { JSON_ACCEPT, addResults, errorText, pickFiles, readRecordFiles, resultFileLabel, type FileResult } from './fileImport';
import { datasetRanges, mergeSummaries, screenDataset, type Screening } from './screening';
import { processRecord } from '../data/denoise';
import { countParts, kindParts } from '../data/denoiseText';
import { useDenoise } from '../store/hooks';
import { shellUi, useShellUi, type ImporterTab } from './uiStore';

interface ParseOk {
  ok: true;
  ds: Dataset;
  rows: number;
  cols: number;
  gray: [number, number];
  level: [number, number];
  svm: [number, number];
  missing: number;
  /** What the denoise will do with the parsed table (C7; the table is imported raw). */
  screening: Screening | null;
}
type ParseResult = ParseOk | { ok: false; error: string } | null;

function analyse(text: string, factor: number): ParseResult {
  if (!text.trim()) return null;
  try {
    // The name is set at import time (title line, form fields or a default); never from here.
    const ds = parseRawData(text, '-', Number.isFinite(factor) && factor > 0 ? factor : 1);
    const m = ds.matrix;
    const svms = ds.data.map((p) => p.svm);
    const levels = m.headerNits.filter((n) => Number.isFinite(n));
    return {
      ok: true,
      ds,
      rows: m.rows.length,
      cols: m.cols.length,
      gray: [Math.min(...m.rows), Math.max(...m.rows)],
      level: levels.length ? [Math.min(...levels), Math.max(...levels)] : [0, 0],
      svm: svms.length ? [Math.min(...svms), Math.max(...svms)] : [0, 0],
      missing: m.rows.length * m.cols.length - ds.data.length,
      screening: screenDataset(ds),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

interface TableResult {
  title: string;
  res: ParseResult;
}

/** Parse every table of a paste (several stacked tables are split by their title/header rows). */
function analyseAll(text: string, factor: number): TableResult[] {
  if (!text.trim()) return [];
  return splitTables(text).map((tb) => ({ title: tb.title, res: analyse(tb.text, factor) }));
}

/** `count` default record names ("导入的记录 3", …) not used by any existing record. */
function defaultNames(t: TFunction, count: number): string[] {
  const used = new Set(useAppStore.getState().records.flatMap((r) => [r.name, r.device]));
  const out: string[] = [];
  for (let n = 1; out.length < count; n++) {
    const name = t('shell.importer.defaultName', { n });
    if (!used.has(name)) out.push(name);
  }
  return out;
}

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function Importer() {
  const t = useT();
  const { open, tab } = useShellUi((s) => s.importer);
  const [jsonResults, setJsonResults] = useState<FileResult[]>([]);
  const paste = usePasteState();

  const seed = useShellUi((s) => s.importer.seed);

  useEffect(() => {
    if (!open) {
      setJsonResults([]);
      paste.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Content handed over by a window drop / file picker.
  useEffect(() => {
    if (!open || !seed) return;
    if (seed.text !== undefined) paste.loadText(seed.text, seed.name ?? '');
    if (seed.files) setJsonResults((prev) => [...prev, ...seed.files!]);
    shellUi.consumeImporterSeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  // Paste while focus is not in a text field (e.g. right after opening): the text goes to the data box.
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text.trim()) return;
    e.preventDefault();
    if (tab !== 'paste') shellUi.setImporterTab('paste');
    paste.setText(text);
  };

  const addJsonFiles = async (files: File[]) => {
    if (!files.length) return;
    const res = await readRecordFiles(files);
    setJsonResults((prev) => [...prev, ...res]);
  };

  // Dropping onto the dialog: tables go into the paste box, JSON files into the file list.
  const onDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    const table = files.find((f) => /\.(tsv|txt)$/i.test(f.name));
    const jsons = files.filter((f) => /\.json$/i.test(f.name));
    if (tab === 'paste' && table && !jsons.length) {
      paste.loadText(await table.text(), table.name.replace(/\.[^.]+$/, ''));
      return;
    }
    shellUi.setImporterTab('json');
    await addJsonFiles(files);
  };

  const okCount = jsonResults.filter((r) => r.ok).length;

  const footer =
    tab === 'paste' ? (
      <>
        <Button size="sm" variant="ghost" onClick={shellUi.closeImporter}>
          {t('common.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Upload size={13} />}
          disabled={paste.multi ? paste.multi.every((m) => !m.res?.ok) : !paste.result?.ok}
          onClick={() => paste.submit(t)}
          data-testid="importer-submit"
        >
          {paste.multi ? t('shell.importer.submitN', { n: paste.multi.filter((m) => m.res?.ok).length }) : t('shell.importer.submit')}
        </Button>
      </>
    ) : (
      <>
        <Button size="sm" variant="ghost" onClick={shellUi.closeImporter}>
          {t('common.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Upload size={13} />}
          disabled={okCount === 0}
          data-testid="importer-submit-json"
          onClick={() => {
            addResults(
              jsonResults.filter((r) => r.ok),
              t,
            );
            shellUi.closeImporter();
          }}
        >
          {okCount > 1 ? t('shell.importer.submitN', { n: okCount }) : t('shell.importer.submit')}
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={shellUi.closeImporter}
      title={t('shell.importer.title')}
      icon={<Upload size={15} className="text-ink-3" />}
      widthClass="max-w-[920px]"
      closeLabel={t('common.close')}
      footer={footer}
      onPaste={onPaste}
    >
      <div
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && (e.preventDefault(), e.stopPropagation())}
        onDrop={(e) => void onDrop(e)}
        data-testid="importer"
      >
        <Segmented<ImporterTab>
          size="md"
          aria-label={t('shell.importer.title')}
          value={tab}
          onChange={shellUi.setImporterTab}
          options={[
            {
              value: 'paste',
              label: t('shell.importer.tabPaste'),
              icon: <ClipboardPaste size={14} />,
            },
            {
              value: 'json',
              label: t('shell.importer.tabJson'),
              icon: <FileJson size={14} />,
            },
          ]}
        />
        <div className="mt-4">
          {tab === 'paste' ? (
            <PasteTab state={paste} />
          ) : (
            <JsonTab results={jsonResults} setResults={setJsonResults} addFiles={addJsonFiles} />
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------

function usePasteState() {
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [mode, setMode] = useState('');
  const [metaTouched, setMetaTouched] = useState(false);
  const [factor, setFactor] = useState(1);
  const [text, setText] = useState('');
  const deferred = useDeferredValue(text);
  const deferredFactor = useDeferredValue(factor);
  const tables = useMemo(() => analyseAll(deferred, deferredFactor), [deferred, deferredFactor]);
  const result: ParseResult = tables.length === 1 ? tables[0].res : null;
  const multi = tables.length > 1 ? tables : null;

  const onName = (v: string) => {
    setName(v);
    if (!metaTouched) {
      const g = guessDeviceMode(v);
      setDevice(g.device);
      setMode(g.mode);
    }
  };

  return {
    name,
    device,
    mode,
    factor,
    text,
    result,
    multi,
    metaTouched,
    setName: onName,
    setDevice: (v: string) => {
      setDevice(v);
      setMetaTouched(true);
    },
    setMode: (v: string) => {
      setMode(v);
      setMetaTouched(true);
    },
    setFactor,
    setText: (v: string) => {
      setText(v);
      // A title line above the table ("小米 18 Pro Max 自适应刷新 Pro 关") names the record.
      if (!name.trim()) {
        const title = splitTables(v)[0]?.title;
        if (title) onName(title);
      }
    },
    loadText: (v: string, fallbackName: string) => {
      setText(v);
      if (!name.trim()) onName(splitTables(v)[0]?.title || fallbackName);
    },
    reset: () => {
      setName('');
      setDevice('');
      setMode('');
      setMetaTouched(false);
      setFactor(1);
      setText('');
    },
    submit: (t: TFunction) => {
      const all = analyseAll(text, factor);
      const lang = useAppStore.getState().lang;
      // Imported raw (docs/adr/0012 addendum): the denoise is applied when shown, never stored.
      const clean = (res: ParseOk) => res.ds;
      if (all.length > 1) {
        const untitled = all.filter((tb) => !tb.title && tb.res?.ok).length;
        const fallback = name.trim() ? [] : defaultNames(t, untitled);
        const recs = all.flatMap((tb, i) => {
          if (!tb.res?.ok) return [];
          const title = tb.title || (name.trim() ? `${name.trim()} #${i + 1}` : fallback.shift()!);
          const g = guessDeviceMode(title);
          const d = (metaTouched && device.trim()) || g.device || title;
          const m = g.mode;
          return [toRecord({ ...clean(tb.res), name: title }, 'user', { device: d, mode: m, name: m ? `${d} ${m}` : d })];
        });
        if (!recs.length) return;
        const store = useAppStore.getState();
        store.addRecords(recs);
        store.setActive(recs[0].id);
        toast(t('shell.importer.importedN', { n: recs.length }), 'success', 3200);
        shellUi.closeImporter();
        return;
      }
      const res = analyse(text, factor);
      if (!res || !res.ok) return;
      // Never the internal parse name: the form, the title line, or "导入的记录 N".
      const d = device.trim() || guessDeviceMode(name).device || defaultNames(t, 1)[0];
      const m = mode.trim();
      const finalName = name.trim() || (m ? `${d} ${m}` : d);
      const rec = toRecord({ ...clean(res), name: finalName }, 'user', {
        device: d,
        mode: m,
        name: finalName,
      });
      const store = useAppStore.getState();
      store.addRecords([rec]);
      store.setActive(rec.id);
      toast(t('shell.importer.imported', { name: recordLabel(rec, lang) }), 'success', 3200);
      shellUi.closeImporter();
    },
  };
}
type PasteState = ReturnType<typeof usePasteState>;

function PasteTab({ state }: { state: PasteState }) {
  const t = useT();
  const ids = {
    name: useFieldId('imp-name'),
    device: useFieldId('imp-device'),
    mode: useFieldId('imp-mode'),
    factor: useFieldId('imp-factor'),
    data: useFieldId('imp-data'),
  };
  const r = state.result;
  const denoise = useDenoise();
  // What the views will show: the parsed table (imported raw) under the denoise setting.
  const shown = useMemo(() => (r && r.ok ? processRecord(r.ds, { denoise }).record : null), [r, denoise]);
  // Ranges of what will be shown (denoised when the denoise is on), not of the raw table.
  const ranges = useMemo(() => (shown ? datasetRanges(shown) : null), [shown]);
  // The raw maximum, when the denoise hides it (shown as "raw max …, hidden by the denoise").
  const excludedMax = r && r.ok && ranges?.svm && shown !== r.ds && r.svm[1] > ranges.svm[1] ? r.svm[1] : null;
  const screenings = state.multi ? state.multi.map((m) => (m.res?.ok ? m.res.screening : null)) : r && r.ok ? [r.screening] : [];
  const anyOk = state.multi ? state.multi.some((m) => m.res?.ok) : !!(r && r.ok);
  const devicePlaceholder = useMemo(() => defaultNames(t, 1)[0], [t]);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_128px] items-start gap-3">
        <FormRow label={t('shell.importer.name')} htmlFor={ids.name}>
          <TextInput
            id={ids.name}
            data-testid="importer-name"
            value={state.name}
            placeholder={t('shell.importer.namePlaceholder')}
            onChange={(e) => state.setName(e.target.value)}
            disabled={!!state.multi}
          />
        </FormRow>
        <FormRow label={t('shell.importer.device')} htmlFor={ids.device}>
          <TextInput
            id={ids.device}
            data-testid="importer-device"
            value={state.device}
            placeholder={state.multi ? t('shell.importer.devicePlaceholderMulti') : devicePlaceholder}
            onChange={(e) => state.setDevice(e.target.value)}
          />
        </FormRow>
        <FormRow label={t('shell.importer.mode')} htmlFor={ids.mode}>
          <TextInput
            id={ids.mode}
            data-testid="importer-mode"
            value={state.mode}
            placeholder={t('shell.importer.modePlaceholder')}
            onChange={(e) => state.setMode(e.target.value)}
            disabled={!!state.multi}
          />
        </FormRow>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-1">
            <label htmlFor={ids.factor} className="truncate text-xs font-medium text-ink-2" title={t('shell.importer.factor')}>
              {t('shell.importer.factor')}
            </label>
            {state.factor !== 1 && (
              <button
                type="button"
                title={t('shell.importer.factorReset')}
                aria-label={t('shell.importer.factorReset')}
                data-testid="importer-factor-reset"
                onClick={() => state.setFactor(1)}
                className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-2xs text-accent-hover hover:bg-surface-3"
              >
                <RotateCcw size={10} />1×
              </button>
            )}
          </div>
          <NumberInput
            id={ids.factor}
            aria-label={t('shell.importer.factor')}
            className="h-8"
            value={state.factor}
            min={0.01}
            max={100}
            step={0.01}
            suffix="×"
            errorText={t('shell.importer.factorError')}
            onChange={state.setFactor}
          />
        </div>
      </div>
      <p className="-mt-2 text-2xs text-ink-3">
        {state.multi ? t('shell.importer.multiHint') : t('shell.importer.autoFilled')} · {t('shell.importer.factorHint')}
      </p>

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_240px] gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-end justify-between gap-2">
            <label htmlFor={ids.data} className="text-xs font-medium text-ink-2">
              {t('shell.importer.data')}
            </label>
            <div className="flex gap-1">
              {state.text && (
                <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => state.setText('')}>
                  {t('shell.importer.clear')}
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                icon={<Sparkles size={12} />}
                data-testid="importer-example"
                onClick={() => {
                  state.setText(EXAMPLE_TSV);
                  state.setName(t('shell.importer.exampleName'));
                }}
              >
                {t('shell.importer.loadExample')}
              </Button>
            </div>
          </div>
          <textarea
            id={ids.data}
            data-testid="importer-text"
            value={state.text}
            onChange={(e) => state.setText(e.target.value)}
            placeholder={t('shell.importer.placeholder')}
            spellCheck={false}
            wrap="off"
            autoFocus
            className="h-[280px] w-full resize-none rounded-md bg-surface-1 p-2.5 font-mono text-[11px] leading-[1.55] text-ink-2 ring-1 ring-inset ring-line placeholder:text-ink-4 hover:ring-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            style={{ tabSize: 8 }}
          />
          <p className="text-2xs leading-snug text-ink-3">{t('shell.importer.dataHint')}</p>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="text-xs font-medium text-ink-2">{t('shell.importer.preview')}</div>
          <div
            data-testid="importer-preview"
            className={cn(
              'flex h-[280px] flex-col rounded-md p-3 ring-1 ring-inset',
              state.multi ? 'bg-surface-1 ring-line' : !r ? 'bg-surface-1 ring-line' : r.ok ? 'bg-safe/[0.06] ring-safe/25' : 'bg-critical/[0.07] ring-critical/30',
            )}
          >
            {state.multi && <MultiPreview tables={state.multi} deviceOverride={state.metaTouched ? state.device.trim() : ''} />}
            {!state.multi && !r && (
              <div className="m-auto flex flex-col items-center gap-2 text-center text-2xs text-ink-3">
                <ClipboardPaste size={20} className="text-ink-4" />
                {t('shell.importer.previewEmpty')}
              </div>
            )}
            {!state.multi && r && !r.ok && (
              <div className="flex items-start gap-2 text-xs leading-relaxed text-red-200">
                <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                <span>{errorText(t, r.error)}</span>
              </div>
            )}
            {!state.multi && r && r.ok && shown && ranges && (
              <>
                <div className="flex items-center gap-2 text-xs font-medium text-ink-1">
                  <CheckCircle2 size={15} className="shrink-0 text-green-400" />
                  {t('shell.importer.size', { rows: r.rows, cols: r.cols })}
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-2xs">
                  <dt className="text-ink-3">{t('shell.importer.grayRange')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1" data-testid="importer-gray-range">
                    {ranges.gray ? `G${ranges.gray[0]} – G${ranges.gray[1]}` : '—'}
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.levelRange')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1" data-testid="importer-level-range">
                    {ranges.level ? `${fmtNum(ranges.level[0])} – ${fmtNum(ranges.level[1])} nits` : '—'}
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.svmRange')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1" data-testid="importer-svm-range">
                    {ranges.svm ? `${ranges.svm[0].toFixed(3)} – ${ranges.svm[1].toFixed(3)}` : '—'}
                    {excludedMax !== null && (
                      <div className="font-sans text-amber-300/90" title={t('shell.importer.rawMaxHint')}>
                        {t('shell.importer.rawMax', { v: fmtNum(excludedMax) })}
                      </div>
                    )}
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.points')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1">
                    {shown.data.length} / {r.rows * r.cols}
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.missing')}</dt>
                  <dd className={cn('text-right font-mono tabular-nums', r.missing ? 'text-amber-300' : 'text-ink-1')}>
                    {r.missing || t('shell.importer.missingNone')}
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.screen.label')}</dt>
                  <dd className={cn('text-right font-mono tabular-nums', r.screening?.summary.touched ? 'text-sky-300' : 'text-ink-1')} data-testid="importer-denoise">
                    {r.screening?.summary.touched || t('shell.importer.missingNone')}
                  </dd>
                </dl>
                <MiniMatrix ds={shown} />
              </>
            )}
          </div>
        </div>
      </div>
      {anyOk && <DenoisePreview screenings={screenings} />}
    </div>
  );
}

/**
 * Denoise preview (C7, docs/adr/0012 addendum): what the view-time denoise will do with the
 * tables / files, in plain words. Nothing to decide: records are imported raw, and the denoise is
 * one switch in the settings. Shown under the paste box and the file list.
 */
function DenoisePreview({ screenings }: { screenings: (Screening | null | undefined)[] }) {
  const t = useT();
  const denoise = useDenoise();
  const sum = mergeSummaries(screenings);
  if (!screenings.some((s) => s)) return null;
  if (!sum.touched && !sum.levelsEstimated)
    return (
      <p className="-mt-1 flex items-center gap-1.5 text-2xs text-ink-3" data-testid="importer-screening">
        <ShieldCheck size={13} className="shrink-0 text-green-400/80" />
        {t('shell.importer.screen.none')}
      </p>
    );
  return (
    <div className="-mt-1 flex items-start gap-2 rounded-md bg-surface-1 px-3 py-2.5 ring-1 ring-inset ring-line" data-testid="importer-screening">
      <Sparkles size={14} className="mt-px shrink-0 text-sky-300/90" />
      <div className="min-w-0 text-2xs leading-snug">
        <div className="text-xs text-ink-1">{t('shell.importer.screen.found', { n: sum.touched })}</div>
        <div className="mt-0.5 text-ink-2">{countParts(sum, t).join(' · ')}</div>
        <div className="mt-0.5 text-ink-3">{kindParts(sum.byKind, t).join(' · ')}</div>
        <div className="mt-1 text-ink-3">{t(denoise ? 'shell.importer.screen.raw' : 'shell.importer.screen.off')}</div>
      </div>
    </div>
  );
}

/** Preview for a paste holding several tables: one line per table (title → device · mode, size, status). */
function MultiPreview({ tables, deviceOverride }: { tables: TableResult[]; deviceOverride: string }) {
  const t = useT();
  const okCount = tables.filter((x) => x.res?.ok).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="importer-multi">
      <div className="flex items-center gap-2 text-xs font-medium text-ink-1">
        <CheckCircle2 size={15} className="shrink-0 text-green-400" />
        {t('shell.importer.multiFound', { n: tables.length, ok: okCount })}
      </div>
      <ul className="mt-2.5 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {tables.map((tb, i) => {
          const g = guessDeviceMode(tb.title);
          const device = deviceOverride || g.device || t('shell.importer.untitled', { i: i + 1 });
          const ok = !!tb.res?.ok;
          return (
            <li key={i} className={cn('rounded-md px-2.5 py-2 ring-1 ring-inset', ok ? 'bg-safe/[0.06] ring-safe/20' : 'bg-critical/[0.07] ring-critical/30')}>
              <div className="flex items-center gap-1.5">
                {ok ? <CheckCircle2 size={12} className="shrink-0 text-green-400" /> : <AlertCircle size={12} className="shrink-0 text-red-400" />}
                <span className="truncate text-2xs font-medium text-ink-1" title={tb.title}>
                  {tb.title || t('shell.importer.untitled', { i: i + 1 })}
                </span>
              </div>
              <div className="mt-1 truncate text-2xs text-ink-3" title={`${device}${g.mode ? ` · ${g.mode}` : ''}`}>
                {device}
                {g.mode ? ` · ${g.mode}` : ''}
              </div>
              <div className={cn('mt-0.5 font-mono text-2xs tabular-nums', ok ? 'text-ink-2' : 'text-red-300')}>
                {tb.res?.ok ? t('shell.importer.size', { rows: tb.res.rows, cols: tb.res.cols }) : tb.res ? errorText(t, tb.res.error) : ''}
              </div>
              {tb.res?.ok && !!tb.res.screening?.summary.touched && (
                <div className="mt-0.5 truncate text-2xs text-sky-300/90" title={[countParts(tb.res.screening.summary, t).join(' · '), kindParts(tb.res.screening.summary.byKind, t).join(' · ')].join('\n')}>
                  {t('shell.importer.screen.perTable', { n: tb.res.screening.summary.touched })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Tiny heatmap of the parsed grid in the current colormap (rows = gray, cols = brightness); missing cells stay empty. */
function MiniMatrix({ ds }: { ds: Dataset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colormap = useAppStore((s) => s.colormap);
  const { rows, cols, grid } = ds.matrix;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const cw = w / cols.length;
    const ch = h / rows.length;
    const color = new THREE.Color();
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < cols.length; j++) {
        const p = grid[i][j];
        if (p) {
          getJsColor(p.svm, colormap, color);
          ctx.fillStyle = `#${color.getHexString()}`;
        } else ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(j * cw, i * ch, Math.max(1, cw - 0.75), Math.max(1, ch - 0.75));
      }
    }
  }, [rows, cols, grid, colormap]);
  return <canvas ref={ref} className="mt-auto h-20 w-full rounded-sm" aria-hidden="true" />;
}

function JsonTab({
  results,
  setResults,
  addFiles,
}: {
  results: FileResult[];
  setResults: React.Dispatch<React.SetStateAction<FileResult[]>>;
  addFiles: (files: File[]) => Promise<void>;
}) {
  const t = useT();
  const lang = useLang();
  const [over, setOver] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div
        onDragEnter={() => setOver(true)}
        onDragLeave={() => setOver(false)}
        onDrop={() => setOver(false)}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center transition-colors',
          over ? 'border-accent bg-accent-muted' : 'border-line-strong bg-surface-1',
        )}
      >
        <FileUp size={24} className={over ? 'text-accent-hover' : 'text-ink-3'} />
        <div className="flex items-center gap-2 text-xs text-ink-2">
          {t('shell.importer.dropHere')}
          <Button size="xs" variant="secondary" data-testid="importer-pick" onClick={() => void pickFiles(`${JSON_ACCEPT},.tsv,.txt`).then(addFiles)}>
            {t('shell.importer.pick')}
          </Button>
        </div>
        <p className="text-2xs text-ink-3">{t('shell.importer.jsonHint')}</p>
      </div>
      {results.length > 0 && (
        <ul className="max-h-[260px] divide-y divide-line overflow-y-auto rounded-lg ring-1 ring-inset ring-line" data-testid="importer-results">
          {results.map((r, i) => {
            const fileLabel = resultFileLabel(t, r);
            const n = r.ok ? (r.screening?.summary.touched ?? 0) : 0;
            return (
              <li key={`${fileLabel}-${i}`} className="flex items-center gap-3 px-3 py-2">
                {r.ok ? <CheckCircle2 size={15} className="shrink-0 text-green-400" /> : <AlertCircle size={15} className="shrink-0 text-red-400" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-ink-1" title={r.ok && r.record ? recordLabel(r.record, lang) : fileLabel}>
                    {r.ok && r.record ? recordLabel(r.record, lang) : fileLabel}
                  </div>
                  <div className={cn('truncate text-2xs', r.ok ? 'text-ink-3' : 'text-red-300')} title={fileLabel}>
                    {r.ok && r.record ? `${fileLabel} · ${t('shell.importer.fileOk', { points: r.record.data.length })}` : `${fileLabel} · ${errorText(t, r.error)}`}
                    {n > 0 && (
                      <span className="text-sky-300/90" title={[countParts(r.screening!.summary, t).join(' · '), kindParts(r.screening!.summary.byKind, t).join(' · ')].join('\n')}>
                        {' · '}
                        {t('shell.importer.screen.perTable', { n })}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  title={t('shell.importer.remove')}
                  aria-label={t('shell.importer.remove')}
                  onClick={() => setResults((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded p-1 text-ink-3 hover:bg-surface-4 hover:text-ink-1"
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {results.some((r) => r.ok) && <DenoisePreview screenings={results.filter((r) => r.ok).map((r) => r.screening)} />}
    </div>
  );
}
