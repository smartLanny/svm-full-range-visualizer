import React from 'react';
import { AlertTriangle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { translate } from '../i18n';
import { getAppState } from '../store/appStore';
import type { Lang } from '../types';
import { clearLocalDataAndReload, resetViewAndReload } from './actions';

/** Language for the fallback UI; never throws (the store itself may be what broke). */
function safeLang(): Lang {
  try {
    const l = getAppState().lang;
    return l === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}
const tr = (key: string) => translate(safeLang(), `shell.error.${key}`);

interface Props {
  children: React.ReactNode;
  /** 'app' = full-page recovery screen; 'view' = in-place card, the rest of the shell keeps working. */
  scope: 'app' | 'view';
}
interface State {
  error: Error | null;
}

/**
 * Catches render errors so a bad record or setting never leaves a blank page. The fallback offers
 * recovery without devtools: retry, reset the display settings, or clear local data.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('UI error caught by boundary:', error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const app = this.props.scope === 'app';
    return (
      <div
        role="alert"
        data-testid={app ? 'app-error' : 'view-error'}
        className={app ? 'flex h-full items-center justify-center bg-canvas p-6' : 'absolute inset-0 flex items-center justify-center bg-canvas p-6'}
      >
        <div className="flex max-w-md flex-col items-center rounded-xl bg-surface-2 px-6 py-6 text-center shadow-panel ring-1 ring-line">
          <AlertTriangle size={26} className="text-amber-300" />
          <h2 className="mt-3 text-sm font-semibold text-ink-1">{tr(app ? 'appTitle' : 'viewTitle')}</h2>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">{tr('body')}</p>
          <p className="mt-2 max-w-full truncate font-mono text-2xs text-ink-4" title={error.message}>
            {error.message}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <FallbackButton icon={<RefreshCw size={13} />} onClick={app ? () => location.reload() : this.retry} primary>
              {tr(app ? 'reload' : 'retry')}
            </FallbackButton>
            <FallbackButton icon={<RotateCcw size={13} />} onClick={() => void resetViewAndReload()}>
              {tr('resetView')}
            </FallbackButton>
            <FallbackButton icon={<Trash2 size={13} />} onClick={() => void clearLocalDataAndReload()} danger>
              {tr('clearData')}
            </FallbackButton>
          </div>
          <p className="mt-3 text-2xs leading-snug text-ink-4">{tr('clearHint')}</p>
        </div>
      </div>
    );
  }
}

/** Plain button (the ui kit may be what failed; keep the fallback self-contained). */
function FallbackButton({
  children,
  icon,
  onClick,
  primary,
  danger,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ' +
        (primary
          ? 'bg-accent text-white ring-accent hover:bg-accent-hover'
          : danger
            ? 'bg-surface-3 text-red-300 ring-critical/40 hover:bg-critical/15'
            : 'bg-surface-3 text-ink-1 ring-line hover:bg-surface-4')
      }
    >
      {icon}
      {children}
    </button>
  );
}
