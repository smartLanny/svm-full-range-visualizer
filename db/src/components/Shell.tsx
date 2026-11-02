import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Route } from '../lib/route';
import { loadSiteInfo, useAsync } from '../lib/data';
import { isoDate } from '../lib/format';
import { VIEW_ANGLE_SIM_URL } from '../lib/angle';
import { SVM_TOOL_URL } from './ui';

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="dbg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8fb8ff" />
          <stop offset="1" stopColor="#2a5bd6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="#11151d" />
      <rect x="20" y="9" width="24" height="46" rx="6" fill="none" stroke="url(#dbg)" strokeWidth="4" />
      <rect x="25" y="19" width="14" height="4" rx="2" fill="#8fb8ff" />
      <rect x="25" y="27" width="10" height="4" rx="2" fill="#4c8dff" opacity=".8" />
      <rect x="25" y="35" width="14" height="4" rx="2" fill="#4c8dff" opacity=".5" />
    </svg>
  );
}

function ToolLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full px-3 text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1"
    >
      {children}
      <ArrowUpRight size={13} className="opacity-60" aria-hidden />
    </a>
  );
}

/** Data version line: data/version.json when a batch wrote one, else the last data commit. */
export function DataVersion({ className }: { className?: string }) {
  const info = useAsync(loadSiteInfo, 'site-info');
  if (info.status !== 'ready') return null;
  const v = info.data.version;
  const date = v?.date ?? isoDate(info.data.dataCommitDate);
  if (!v?.version && !date) return null;
  return (
    <span className={className}>
      {v?.version ? `数据版本 ${v.version}` : `数据更新于 ${date}`}
      {!v?.version && info.data.dataCommit ? <span className="text-ink-4"> · {info.data.dataCommit}</span> : null}
    </span>
  );
}

export function Shell({ route, children }: { route: Route; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-line/70 bg-canvas/75 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <a href="#/" className="flex min-w-0 items-center gap-2.5" aria-label="屏幕数据库首页">
            <Logo />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[15px] font-semibold tracking-tight text-ink-1">屏幕数据库</span>
              <span className="truncate text-[11px] text-ink-3">野生的装机宅</span>
            </span>
          </a>
          {route.page !== 'home' && (
            <a
              href="#/"
              className="ml-2 hidden h-8 items-center rounded-full px-3 text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1 sm:inline-flex"
            >
              全部机型
            </a>
          )}
          <nav className="ml-auto flex items-center gap-0.5" aria-label="相关工具">
            <ToolLink href={SVM_TOOL_URL}>频闪工具</ToolLink>
            <span className="hidden sm:inline">
              <ToolLink href={VIEW_ANGLE_SIM_URL}>可视角仿真</ToolLink>
            </span>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-16 sm:px-6 lg:px-8">{children}</main>

      <footer className="border-t border-line/60">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-4 py-6 text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              实测数据 · <span className="text-ink-2">B 站 野生的装机宅</span>
            </span>
            <DataVersion />
          </div>
          <div className="text-ink-4">未测的项目标为「未测 / 待测」，数值不估算、不补齐</div>
        </div>
      </footer>
    </div>
  );
}
