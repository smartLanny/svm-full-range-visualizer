import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ClipboardPaste, FileJson, FileUp, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useT, type TFunction } from '../i18n';
import { parseRawData } from '../data/parse';
import { guessDeviceMode, toRecord } from '../data/records';
import { EXAMPLE_TSV } from '../data/exampleTsv';
import type { Dataset } from '../types';
import { useAppStore } from '../store/appStore';
import * as THREE from 'three';
import { getJsColor } from '../colormaps';
import { Button, Dialog, NumberInput, Segmented, cn, toast } from '../ui';
import { FormRow, TextInput, useFieldId } from './controls';
import { JSON_ACCEPT, addResults, errorText, pickFiles, readRecordFiles, type FileResult } from './fileImport';
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
}
type ParseResult = ParseOk | { ok: false; error: string } | null;

function analyse(text: string, factor: number): ParseResult {
  if (!text.trim()) return null;
  try {
    const ds = parseRawData(text, 'preview', Number.isFinite(factor) && factor > 0 ? factor : 1);
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
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function Importer() {
  const t = useT();
  const { open, tab } = useShellUi((s) => s.importer);
  const [jsonResults, setJsonResults] = useState<FileResult[]>([]);
  const paste = usePasteState();

  useEffect(() => {
    if (!open) {
      setJsonResults([]);
      paste.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
          disabled={!paste.result?.ok}
          onClick={() => paste.submit(t)}
          data-testid="importer-submit"
        >
          {t('shell.importer.submit')}
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
          {tab === 'paste' ? <PasteTab state={paste} /> : <JsonTab results={jsonResults} setResults={setJsonResults} addFiles={addJsonFiles} />}
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
  const result = useMemo(() => analyse(deferred, deferredFactor), [deferred, deferredFactor]);

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
    setText,
    loadText: (v: string, fallbackName: string) => {
      setText(v);
      if (!name.trim()) onName(fallbackName);
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
      const res = analyse(text, factor);
      if (!res || !res.ok) return;
      const d = device.trim() || guessDeviceMode(name).device || res.ds.name;
      const m = mode.trim();
      const finalName = name.trim() || (m ? `${d} ${m}` : d);
      const rec = toRecord({ ...res.ds, name: finalName }, 'user', {
        device: d,
        mode: m,
        name: finalName,
      });
      const store = useAppStore.getState();
      store.addRecords([rec]);
      store.setActive(rec.id);
      toast(t('shell.importer.imported', { name: finalName }), 'success');
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
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px] gap-3">
        <FormRow label={t('shell.importer.name')} htmlFor={ids.name}>
          <TextInput
            id={ids.name}
            data-testid="importer-name"
            value={state.name}
            placeholder={t('shell.importer.namePlaceholder')}
            onChange={(e) => state.setName(e.target.value)}
            autoFocus
          />
        </FormRow>
        <FormRow label={t('shell.importer.device')} htmlFor={ids.device}>
          <TextInput id={ids.device} data-testid="importer-device" value={state.device} onChange={(e) => state.setDevice(e.target.value)} />
        </FormRow>
        <FormRow label={t('shell.importer.mode')} htmlFor={ids.mode}>
          <TextInput
            id={ids.mode}
            data-testid="importer-mode"
            value={state.mode}
            placeholder={t('shell.importer.modePlaceholder')}
            onChange={(e) => state.setMode(e.target.value)}
          />
        </FormRow>
        <FormRow label={t('shell.importer.factor')} htmlFor={ids.factor}>
          <NumberInput
            aria-label={t('shell.importer.factor')}
            className="h-8"
            value={state.factor}
            min={0.01}
            max={100}
            step={0.01}
            suffix="×"
            onChange={state.setFactor}
          />
        </FormRow>
      </div>
      <p className="-mt-2 text-2xs text-ink-3">
        {t('shell.importer.autoFilled')} · {t('shell.importer.factorHint')}
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
              !r ? 'bg-surface-1 ring-line' : r.ok ? 'bg-safe/[0.06] ring-safe/25' : 'bg-critical/[0.07] ring-critical/30',
            )}
          >
            {!r && (
              <div className="m-auto flex flex-col items-center gap-2 text-center text-2xs text-ink-3">
                <ClipboardPaste size={20} className="text-ink-4" />
                {t('shell.importer.previewEmpty')}
              </div>
            )}
            {r && !r.ok && (
              <div className="flex items-start gap-2 text-xs leading-relaxed text-red-200">
                <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                <span>{errorText(t, r.error)}</span>
              </div>
            )}
            {r && r.ok && (
              <>
                <div className="flex items-center gap-2 text-xs font-medium text-ink-1">
                  <CheckCircle2 size={15} className="shrink-0 text-green-400" />
                  {t('shell.importer.size', { rows: r.rows, cols: r.cols })}
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-2xs">
                  <dt className="text-ink-3">{t('shell.importer.grayRange')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1">
                    G{r.gray[0]} – G{r.gray[1]}
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.levelRange')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1">
                    {fmtNum(r.level[0])} – {fmtNum(r.level[1])} nits
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.svmRange')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1">
                    {r.svm[0].toFixed(3)} – {r.svm[1].toFixed(3)}
                  </dd>
                  <dt className="text-ink-3">{t('shell.importer.points')}</dt>
                  <dd className="text-right font-mono tabular-nums text-ink-1">{r.ds.data.length}</dd>
                  <dt className="text-ink-3">{t('shell.importer.missing')}</dt>
                  <dd className={cn('text-right font-mono tabular-nums', r.missing ? 'text-amber-300' : 'text-ink-1')}>
                    {r.missing || t('shell.importer.missingNone')}
                  </dd>
                </dl>
                <MiniMatrix ds={r.ds} />
              </>
            )}
          </div>
        </div>
      </div>
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
          {results.map((r, i) => (
            <li key={`${r.fileName}-${i}`} className="flex items-center gap-3 px-3 py-2">
              {r.ok ? <CheckCircle2 size={15} className="shrink-0 text-green-400" /> : <AlertCircle size={15} className="shrink-0 text-red-400" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-ink-1" title={r.fileName}>
                  {r.ok && r.record ? r.record.name : r.fileName}
                </div>
                <div className={cn('truncate text-2xs', r.ok ? 'text-ink-3' : 'text-red-300')}>
                  {r.ok && r.record ? `${r.fileName} · ${t('shell.importer.fileOk', { points: r.record.data.length })}` : errorText(t, r.error)}
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
          ))}
        </ul>
      )}
    </div>
  );
}
