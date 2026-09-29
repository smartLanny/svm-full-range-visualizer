import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, Info, Keyboard, ShieldCheck } from 'lucide-react';
import { useT } from '../i18n';
import { Button, Dialog, Kbd } from '../ui';
import { Logo } from './Logo';
import { clearLocalDataAndReload } from './actions';
import { shellUi, useShellUi } from './uiStore';

export const APP_VERSION = '2.0.0';
export const REPO_URL = 'https://github.com/smartLanny/svm-full-range-visualizer';

/** Generic confirm dialog. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      icon={danger ? <AlertTriangle size={15} className="text-red-400" /> : undefined}
      widthClass="max-w-md"
      closeLabel={t('common.close')}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant={danger ? 'danger' : 'primary'}
            data-testid="confirm-ok"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-ink-2">{body}</div>
    </Dialog>
  );
}

function Row({ keys, label }: { keys: React.ReactNode[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-xs text-ink-2">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <Kbd key={i} className="h-5 min-w-5 px-1.5 text-[11px]">
            {k}
          </Kbd>
        ))}
      </span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</div>
      <div className="divide-y divide-line/60">{children}</div>
    </div>
  );
}

export function ShortcutsDialog() {
  const t = useT();
  const open = useShellUi((s) => s.shortcutsOpen);
  return (
    <Dialog
      open={open}
      onClose={() => shellUi.setShortcuts(false)}
      title={t('shell.shortcuts.title')}
      icon={<Keyboard size={15} className="text-ink-3" />}
      widthClass="max-w-lg"
      closeLabel={t('common.close')}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Group title={t('shell.shortcuts.playback')}>
          <Row keys={[t('shell.shortcuts.spaceKey')]} label={t('shell.shortcuts.space')} />
          <Row keys={['←', '→']} label={t('shell.shortcuts.seek')} />
          <Row keys={['Shift', '←/→']} label={t('shell.shortcuts.seekFast')} />
          <Row keys={['R']} label={t('shell.shortcuts.restart')} />
        </Group>
        <Group title={t('shell.shortcuts.views')}>
          <Row keys={['1', '2', '3']} label={t('shell.shortcuts.tabs')} />
          <Row keys={['T']} label={t('shell.shortcuts.topView')} />
          <Row keys={['H']} label={t('shell.shortcuts.hideLabels')} />
        </Group>
        <Group title={t('shell.shortcuts.general')}>
          <Row keys={['F']} label={t('shell.shortcuts.present')} />
          <Row keys={['Esc']} label={t('shell.shortcuts.exit')} />
          <Row keys={['?']} label={t('shell.shortcuts.help')} />
        </Group>
      </div>
      <p className="mt-4 text-2xs text-ink-3">{t('shell.shortcuts.note')}</p>
    </Dialog>
  );
}

export function AboutDialog() {
  const t = useT();
  const open = useShellUi((s) => s.aboutOpen);
  return (
    <Dialog
      open={open}
      onClose={() => shellUi.setAbout(false)}
      title={t('shell.settings.aboutTitle')}
      icon={<Info size={15} className="text-ink-3" />}
      widthClass="max-w-md"
      closeLabel={t('common.close')}
    >
      <div className="flex items-start gap-4">
        <Logo size={48} className="shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink-1">{t('common.appName')}</div>
          <div className="mt-0.5 font-mono text-2xs text-ink-3">{t('shell.settings.version', { v: APP_VERSION })}</div>
          <p className="mt-3 text-xs leading-relaxed text-ink-2">{t('shell.settings.aboutBody')}</p>
          <p className="mt-3 flex items-start gap-1.5 text-2xs leading-snug text-ink-3">
            <ShieldCheck size={13} className="mt-px shrink-0 text-green-400/80" />
            {t('shell.settings.privacy')}
          </p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md text-xs text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {t('shell.settings.source')}
            <ExternalLink size={12} />
          </a>
          <div className="mt-1 break-all font-mono text-2xs text-ink-3">{REPO_URL.replace('https://', '')}</div>
        </div>
      </div>
    </Dialog>
  );
}

export function ClearDataDialog() {
  const t = useT();
  const open = useShellUi((s) => s.clearOpen);
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      danger
      title={t('shell.settings.clearTitle')}
      body={t('shell.settings.clearBody')}
      confirmLabel={busy ? t('common.loading') : t('shell.settings.clearConfirm')}
      onConfirm={() => {
        setBusy(true);
        void clearLocalDataAndReload();
      }}
      onClose={() => shellUi.setClear(false)}
    />
  );
}
