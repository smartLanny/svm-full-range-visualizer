import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowUpDown, ChevronRight, Eye, EyeOff, FileDown, FolderOpen, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/appStore';
import { useRecordStyles } from '../store/hooks';
import { useLang, useT, type TFunction } from '../i18n';
import { deviceLabel, modeLabel, recordLabel } from '../data/records';
import { deviceOrder } from '../data/colors';
import { exclusionSummary, type ExclusionSummary } from '../data/anomalies';
import { reasonsText } from './screening';
import type { RecordStyle } from '../data/colors';
import type { Lang, SvmRecord } from '../types';
import { Button, ColorSwatch, MenuItem, cn, toast } from '../ui';
import { IconButton } from './IconBtn';
import { ConfirmDialog } from './ShellDialogs';
import { EditRecordDialog } from './EditRecordDialog';
import { downloadRecordJson, openJsonFiles } from './fileImport';
import { shellUi, useShellUi } from './uiStore';

/** Small line sample in the record's 2D style (device color + mode dash). */
export function LineSample({ style, dim }: { style?: RecordStyle; dim?: boolean }) {
  const color = style?.color ?? '#7d8796';
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true" className={cn('shrink-0 transition-opacity', dim && 'opacity-30')}>
      <line
        x1="1"
        y1="5"
        x2="21"
        y2="5"
        stroke={color}
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeDasharray={style?.dash.length ? style.dash.map((d) => d * 0.75).join(' ') : undefined}
      />
    </svg>
  );
}

function matches(rec: SvmRecord, q: string): boolean {
  if (!q) return true;
  const hay = [rec.name, rec.device, rec.mode, rec.deviceEn ?? '', rec.modeEn ?? ''].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

interface MenuState {
  id: string;
  x: number;
  y: number;
  /** 'end': right-align to x (button anchor); 'start': open at x (cursor). */
  align: 'start' | 'end';
}

export function RecordsPanel() {
  const t = useT();
  const open = useShellUi((s) => s.sidebarOpen);
  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'relative z-10 flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface-1 transition-[width] duration-200 ease-out',
        open ? 'w-[272px]' : 'w-11',
      )}
    >
      {open ? (
        <RecordsPanelBody />
      ) : (
        <div className="flex w-11 flex-col items-center gap-1.5 py-2">
          <IconButton size="sm" label={t('shell.sidebar.expand')} icon={<PanelLeftOpen size={15} />} onClick={shellUi.toggleSidebar} />
          <div className="my-1 h-px w-5 bg-line" />
          <IconButton
            size="sm"
            variant="subtle"
            label={t('shell.sidebar.importHint')}
            icon={<Plus size={15} />}
            onClick={() => shellUi.openImporter('paste')}
          />
          <IconButton size="sm" label={t('shell.sidebar.openJsonHint')} icon={<FolderOpen size={15} />} onClick={() => void openJsonFiles(t)} />
        </div>
      )}
    </aside>
  );
}

function RecordsPanelBody() {
  const t = useT();
  const lang = useLang();
  const records = useAppStore((s) => s.records);
  const hiddenIds = useAppStore((s) => s.hiddenIds);
  const ready = useAppStore((s) => s.ready);
  const styles = useRecordStyles();
  const collapsed = useShellUi((s) => s.collapsedDevices);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<SvmRecord | null>(null);
  const [removing, setRemoving] = useState<SvmRecord | null>(null);

  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const q = query.trim();
  const groups = useMemo(() => {
    const order = deviceOrder(records);
    return order
      .map((device) => {
        const all = records.filter((r) => r.device === device);
        return { device, all, shown: all.filter((r) => matches(r, q)) };
      })
      .filter((g) => g.shown.length > 0);
  }, [records, q]);

  const menuRec = menu ? (records.find((r) => r.id === menu.id) ?? null) : null;
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((id: string, x: number, y: number, align: 'start' | 'end') => setMenu({ id, x, y, align }), []);

  return (
    <div className="flex min-h-0 w-[272px] flex-1 flex-col">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pl-4 pr-1.5">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">{t('shell.sidebar.title')}</span>
        {ready && <span className="ml-1 rounded bg-surface-3 px-1.5 font-mono text-[10px] leading-4 text-ink-3">{records.length}</span>}
        <div className="flex-1" />
        <Button
          size="xs"
          variant="subtle"
          icon={<Plus size={13} />}
          title={t('shell.sidebar.importHint')}
          onClick={() => shellUi.openImporter('paste')}
          data-testid="sidebar-import"
        >
          {t('shell.sidebar.import')}
        </Button>
        <IconButton
          size="sm"
          label={t('shell.sidebar.openJsonHint')}
          icon={<FolderOpen size={15} />}
          data-testid="sidebar-open-json"
          onClick={() => void openJsonFiles(t)}
        />
        <IconButton size="sm" label={t('shell.sidebar.collapse')} icon={<PanelLeftClose size={15} />} onClick={shellUi.toggleSidebar} />
      </div>

      {/* Search */}
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), (e.target as HTMLInputElement).blur())}
            placeholder={t('shell.sidebar.search')}
            aria-label={t('shell.sidebar.search')}
            data-testid="sidebar-search"
            className="h-7 w-full rounded-md bg-surface-2 pl-7 pr-7 text-xs text-ink-1 ring-1 ring-inset ring-line placeholder:text-ink-4 hover:ring-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label={t('shell.sidebar.clearSearch')}
              title={t('shell.sidebar.clearSearch')}
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-3 hover:bg-surface-4 hover:text-ink-1"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" onScroll={() => menu && setMenu(null)}>
        {!ready && <ListSkeleton />}
        {ready && q && groups.length === 0 && <div className="px-3 py-8 text-center text-xs text-ink-3">{t('shell.sidebar.noMatch', { q })}</div>}
        {ready && records.length === 0 && <div className="px-3 py-8 text-center text-xs text-ink-3">{t('shell.empty.title')}</div>}
        {ready &&
          groups.map((g) => (
            <DeviceGroup
              key={g.device}
              lang={lang}
              device={g.device}
              all={g.all}
              shown={g.shown}
              hidden={hidden}
              styles={styles}
              collapsed={!q && collapsed.includes(g.device)}
              onMenu={openMenu}
            />
          ))}
      </div>

      {/* Footer */}
      {ready && records.length > 0 && (
        <div className="shrink-0 border-t border-line px-4 py-2 text-2xs text-ink-3">
          <div className="truncate">
            {hidden.size ? t('shell.sidebar.footer', { n: records.length, h: hidden.size }) : t('shell.sidebar.footerAll', { n: records.length })}
          </div>
          <div className="truncate text-ink-4">{t('shell.sidebar.roleHint')}</div>
        </div>
      )}

      {menu && menuRec && (
        <RowMenu
          rec={menuRec}
          x={menu.x}
          y={menu.y}
          align={menu.align}
          onClose={closeMenu}
          onEdit={() => setEditing(menuRec)}
          onExport={() => toast(t('shell.toast.exported', { file: downloadRecordJson(menuRec, lang) }), 'success')}
          onRemove={() => setRemoving(menuRec)}
        />
      )}
      <EditRecordDialog record={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!removing}
        danger
        title={t('shell.remove.title')}
        confirmLabel={t('common.delete')}
        body={
          removing && (
            <>
              <p className="text-ink-1">{t('shell.remove.body', { name: recordLabel(removing, lang) })}</p>
              <p className="mt-2 text-xs text-ink-3">{removing.source === 'bundled' ? t('shell.remove.bundled') : t('shell.remove.user')}</p>
            </>
          )
        }
        onConfirm={() => {
          if (!removing) return;
          removeWithUndo(removing, t, lang);
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

/** Delete a record; the toast offers Undo (re-inserted at its index with its A / B / hidden state). */
function removeWithUndo(rec: SvmRecord, t: TFunction, lang: Lang) {
  const st = useAppStore.getState();
  const index = st.records.findIndex((r) => r.id === rec.id);
  if (index < 0) return;
  const roles = { a: st.activeId === rec.id, b: st.compareId === rec.id, hidden: st.hiddenIds.includes(rec.id) };
  const layout = st.layout;
  st.removeRecord(rec.id);
  toast(t('shell.remove.done', { name: recordLabel(rec, lang) }), 'info', 8000, {
    label: t('shell.remove.undo'),
    onClick: () => {
      const s = useAppStore.getState();
      if (s.records.some((r) => r.id === rec.id)) return;
      s.insertRecord(rec, Math.min(index, s.records.length), roles);
      // Deleting down to one record forced the single layout: bring the comparison back.
      if (layout !== 'single' && useAppStore.getState().records.length >= 2) useAppStore.getState().set('layout', layout);
    },
  });
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1 px-1 pt-1" aria-hidden="true">
      {[0, 1, 2].map((g) => (
        <div key={g} className="mb-2">
          <div className="shell-skeleton mb-2 mt-1 h-3.5 w-32 rounded" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-2">
              <div className="shell-skeleton h-1 w-5 rounded" />
              <div className="flex-1">
                <div className="shell-skeleton h-3 w-24 rounded" />
                <div className="shell-skeleton mt-1.5 h-2 w-14 rounded" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DeviceGroup({
  lang,
  device,
  all,
  shown,
  hidden,
  styles,
  collapsed,
  onMenu,
}: {
  lang: Lang;
  device: string;
  all: SvmRecord[];
  shown: SvmRecord[];
  hidden: Set<string>;
  styles: Map<string, RecordStyle>;
  collapsed: boolean;
  onMenu: (id: string, x: number, y: number, align: 'start' | 'end') => void;
}) {
  const t = useT();
  const color = styles.get(all[0].id)?.color ?? '#7d8796';
  const allHidden = all.every((r) => hidden.has(r.id));
  const label = deviceLabel(all[0], lang);
  return (
    <div className="mt-1 first:mt-0">
      <div className="group/dev flex h-8 items-center gap-1.5 rounded-md pl-1 pr-1 hover:bg-surface-2">
        <button
          type="button"
          onClick={() => shellUi.toggleDevice(device)}
          aria-expanded={!collapsed}
          title={collapsed ? t('shell.sidebar.expandDevice') : t('shell.sidebar.collapseDevice')}
          className="rounded p-0.5 text-ink-4 hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <ChevronRight size={13} className={cn('transition-transform duration-150', !collapsed && 'rotate-90')} />
        </button>
        <ColorSwatch color={color} label={t('shell.sidebar.deviceColor')} onChange={(c) => useAppStore.getState().setDeviceColor(device, c)} />
        <button
          type="button"
          onClick={() => shellUi.toggleDevice(device)}
          title={label}
          className={cn('min-w-0 flex-1 truncate text-left text-xs font-semibold transition-colors', allHidden ? 'text-ink-3' : 'text-ink-1')}
        >
          {label}
        </button>
        <span className="shrink-0 font-mono text-[10px] text-ink-4">{all.length}</span>
        <IconButton
          size="xs"
          label={allHidden ? t('shell.sidebar.showDevice') : t('shell.sidebar.hideDevice')}
          icon={allHidden ? <EyeOff size={13} /> : <Eye size={13} />}
          className={cn(allHidden ? 'text-ink-4' : 'text-ink-3 opacity-60 group-hover/dev:opacity-100')}
          onClick={() =>
            useAppStore.getState().setHidden(
              all.map((r) => r.id),
              !allHidden,
            )
          }
        />
      </div>
      <div className={cn('shell-collapse', collapsed && 'is-collapsed')}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-px pb-1 pl-2 pt-0.5">
            {shown.map((r) => (
              <RecordRow key={r.id} rec={r} lang={lang} style={styles.get(r.id)} hidden={hidden.has(r.id)} onMenu={onMenu} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RecordRow({
  rec,
  lang,
  style,
  hidden,
  onMenu,
}: {
  rec: SvmRecord;
  lang: Lang;
  style?: RecordStyle;
  hidden: boolean;
  onMenu: (id: string, x: number, y: number, align: 'start' | 'end') => void;
}) {
  const t = useT();
  const { isA, isB, single } = useAppStore(
    useShallow((s) => ({
      isA: s.activeId === rec.id,
      isB: s.compareId === rec.id,
      single: s.layout === 'single',
    })),
  );
  const label = modeLabel(rec, lang) || rec.name || t('shell.sidebar.untitledMode');
  const nominal = rec.matrix.rows.length * rec.matrix.cols.length;
  const valid = rec.data.length;
  const summary = useMemo(() => exclusionSummary(rec), [rec]);
  const full = [
    recordLabel(rec, lang),
    rec.name && rec.name !== recordLabel(rec, lang) && rec.name !== `${rec.device} ${rec.mode}`.trim() ? rec.name : '',
    t('common.exclusion.coverage', { valid, nominal }),
  ]
    .filter(Boolean)
    .join('\n');
  const store = useAppStore.getState;
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isA) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isA]);

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      data-testid="record-row"
      data-record-id={rec.id}
      aria-pressed={isA}
      title={full}
      onClick={() => store().setActive(rec.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') store().setActive(rec.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(rec.id, e.clientX, e.clientY, 'start');
      }}
      className={cn(
        'shell-row group/row relative flex min-h-10 cursor-pointer select-none items-center gap-2 rounded-md py-1 pl-2 pr-1 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring',
        isA ? 'bg-accent-muted ring-1 ring-inset ring-accent/35' : isB ? 'bg-surface-3 ring-1 ring-inset ring-line-strong' : 'hover:bg-surface-2',
      )}
    >
      {isA && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" aria-hidden="true" />}
      <LineSample style={style} dim={hidden} />
      <div className="min-w-0 flex-1">
        {/* Two lines before truncating: the distinguishing tail of a mode ("… Pro off") stays visible. */}
        <div className={cn('line-clamp-2 break-words text-xs leading-4', hidden ? 'text-ink-3' : 'text-ink-1', isA && 'font-medium')} data-testid="record-label">
          {label}
        </div>
        {/* Wraps instead of truncating: the exclusion badge must stay readable. */}
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] leading-3 text-ink-3">
          <span className={cn('shrink-0 rounded-[3px] px-1 py-px', rec.source === 'bundled' ? 'bg-surface-4 text-ink-3' : 'bg-accent-muted text-accent-hover')}>
            {rec.source === 'bundled' ? t('common.bundled') : t('common.user')}
          </span>
          <span className="shrink-0 font-mono tabular-nums" data-testid="record-points">
            {valid < nominal ? t('shell.sidebar.pointsPartial', { valid, nominal }) : t('shell.sidebar.points', { n: valid })}
          </span>
          {summary && <ExclusionBadge summary={summary} />}
        </div>
      </div>

      {/* Role: A / B */}
      <div className="flex w-6 shrink-0 justify-center">
        {isA ? (
          <span
            title={t('shell.sidebar.isA')}
            className="inline-flex h-[18px] w-[18px] items-center justify-center rounded bg-accent text-[10px] font-bold text-white"
          >
            A
          </span>
        ) : isB ? (
          <span
            title={single ? t('shell.sidebar.isBUnused') : t('shell.sidebar.isB')}
            data-testid="record-b-badge"
            className={cn(
              'inline-flex h-[18px] w-[18px] items-center justify-center rounded text-[10px] font-bold',
              single ? 'text-ink-3 ring-1 ring-inset ring-line-strong' : 'bg-ink-2 text-canvas',
            )}
          >
            B
          </span>
        ) : (
          <button
            type="button"
            title={t('shell.sidebar.setB')}
            aria-label={t('shell.sidebar.setB')}
            data-testid="record-set-b"
            onClick={(e) => {
              e.stopPropagation();
              store().setCompare(rec.id);
            }}
            className="shell-reveal inline-flex h-[18px] w-[18px] items-center justify-center rounded text-[10px] font-bold text-ink-3 ring-1 ring-inset ring-line-strong hover:bg-surface-4 hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            B
          </button>
        )}
      </div>

      <IconButton
        size="xs"
        label={hidden ? t('shell.sidebar.show') : t('shell.sidebar.hide')}
        icon={hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        aria-pressed={!hidden}
        data-testid="record-eye"
        className={cn(hidden ? 'text-ink-4' : 'text-ink-3')}
        onClick={(e) => {
          e.stopPropagation();
          store().toggleHidden(rec.id);
        }}
      />
      <IconButton
        size="xs"
        label={t('shell.sidebar.more')}
        icon={<MoreHorizontal size={14} />}
        data-testid="record-more"
        className="shell-reveal text-ink-3"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(rec.id, r.right, r.bottom + 4, 'end');
        }}
      />
    </div>
  );
}

/** "已剔除 N" with a tooltip breaking the exclusions down by reason (docs/adr/0012, contract C4). */
function ExclusionBadge({ summary }: { summary: ExclusionSummary }) {
  const t = useT();
  const tip = [
    t('common.exclusion.title', { n: summary.total }),
    reasonsText(t, summary.byReason, '\n'),
    t('common.exclusion.coverage', { valid: summary.valid, nominal: summary.nominal }),
    t('common.exclusion.detail'),
  ].join('\n');
  return (
    <span
      title={tip}
      aria-label={tip}
      data-testid="record-excluded"
      className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-[3px] bg-amber-400/10 px-1 py-px text-amber-300/90"
    >
      <AlertTriangle size={9} className="shrink-0" />
      {t('common.exclusion.badge', { n: summary.total })}
    </span>
  );
}

function RoleIcon({ role }: { role: 'A' | 'B' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-[14px] w-[14px] items-center justify-center rounded-[3px] text-[9px] font-bold',
        role === 'A' ? 'bg-accent text-white' : 'bg-ink-2 text-canvas',
      )}
    >
      {role}
    </span>
  );
}

/** Record actions menu, rendered in a portal so the scrolling list never clips it. */
function RowMenu({
  rec,
  x,
  y,
  align,
  onClose,
  onEdit,
  onExport,
  onRemove,
}: {
  rec: SvmRecord;
  x: number;
  y: number;
  align: 'start' | 'end';
  onClose: () => void;
  onEdit: () => void;
  onExport: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { isA, isB, hasA, hasB } = useAppStore(
    useShallow((s) => ({ isA: s.activeId === rec.id, isB: s.compareId === rec.id, hasA: s.activeId !== null, hasB: s.compareId !== null })),
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(align === 'end' ? x - w : x, window.innerWidth - w - 8));
    const top = y + h + 8 > window.innerHeight ? Math.max(8, y - h - 8) : y;
    setPos({ left, top });
  }, [x, y, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return createPortal(
    <div ref={ref} role="menu" data-testid="record-menu" className="fixed z-50 w-48 rounded-xl bg-surface-2 p-1.5 shadow-panel ring-1 ring-line" style={pos}>
      <MenuItem role="menuitem" icon={<RoleIcon role="A" />} disabled={isA} onClick={run(() => useAppStore.getState().setActive(rec.id))} data-testid="menu-set-a">
        {t('shell.sidebar.setA')}
      </MenuItem>
      <MenuItem role="menuitem" icon={<RoleIcon role="B" />} disabled={isB} onClick={run(() => useAppStore.getState().setCompare(rec.id))} data-testid="menu-set-b">
        {t('shell.sidebar.setB')}
      </MenuItem>
      <MenuItem
        role="menuitem"
        icon={<ArrowUpDown size={14} />}
        disabled={!hasA || !hasB}
        onClick={run(() => {
          const s = useAppStore.getState();
          if (s.compareId) s.setActive(s.compareId);
        })}
        data-testid="menu-swap"
      >
        {t('shell.sidebar.swap')}
      </MenuItem>
      <div className="mx-2 my-1 h-px bg-line" />
      <MenuItem role="menuitem" icon={<Pencil size={14} />} onClick={run(onEdit)}>
        {t('shell.sidebar.edit')}
      </MenuItem>
      <MenuItem role="menuitem" icon={<FileDown size={14} />} onClick={run(onExport)}>
        {t('shell.sidebar.exportJson')}
      </MenuItem>
      <div className="mx-2 my-1 h-px bg-line" />
      <MenuItem role="menuitem" danger icon={<Trash2 size={14} className="text-red-300" />} onClick={run(onRemove)}>
        {t('shell.sidebar.remove')}
      </MenuItem>
    </div>,
    document.body,
  );
}
