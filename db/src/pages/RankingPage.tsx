import React, { useMemo, useState } from 'react';
import { ArrowLeftRight, Check } from 'lucide-react';
import type { Catalog } from '../../catalog/types';
import { compareHref, deviceHref, replaceRoute } from '../lib/route';
import { loadUniformity, useAsync } from '../lib/data';
import { fmtFixed, fmtSig } from '../lib/format';
import { RANK_METRIC_META, RANK_METRICS, rankUniformity, type RankCond, type RankMetric } from '../lib/ranking';
import { CONDITION_ORDER } from '../lib/uniformity';
import { Glow, Loading, Missing, Pills, STATUS_TEXT } from '../components/ui';
import { cn } from '../../../src/ui/cn';

const COND_LABEL: Record<RankCond, string> = {
  '300': '300 nits 白场',
  '100': '100 nits G20',
  '10': '10 nits G20',
};

/**
 * Uniformity leaderboard (#/rank): every device with the chosen number, best first, with a bar on a
 * shared scale. Tick two rows to open them side by side. Devices without the number are listed by
 * name and status below the table, never ranked.
 */
export function RankingPage({ catalog, cond: cond0, by: by0 }: { catalog: Catalog; cond: RankCond; by: RankMetric }) {
  const index = useAsync(loadUniformity, 'uniformity');
  const [cond, setCond] = useState<RankCond>(cond0);
  const [by, setBy] = useState<RankMetric>(by0);
  const [picked, setPicked] = useState<string[]>([]);
  const meta = RANK_METRIC_META[by];

  const update = (c: RankCond, b: RankMetric) => {
    setCond(c);
    setBy(b);
    replaceRoute({ page: 'rank', cond: c, by: b });
  };

  const ranking = useMemo(() => (index.status === 'ready' ? rankUniformity(catalog.devices, index.data, cond, by) : null), [catalog, index, cond, by]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1], id] : [...p, id]));

  // Bar scale: uniformity from a floor just under the worst value to 100 %; "lower is better"
  // metrics from 0 to the largest value (a shorter bar is better there).
  const values = ranking?.rows.map((r) => r.value) ?? [];
  const lo = meta.higherIsBetter ? Math.max(0, Math.floor((Math.min(...values, 100) - 5) / 10) * 10) : 0;
  const hi = meta.higherIsBetter ? 100 : Math.max(...values, 1e-9);
  const barWidth = (v: number) => `${Math.max(2, ((v - lo) / (hi - lo)) * 100)}%`;
  const g20 = cond !== '300';

  return (
    <div>
      <section className="relative pb-8 pt-10 sm:pb-10 sm:pt-14">
        <Glow />
        <div className="text-[13px] font-medium tracking-wide text-accent-hover">均匀度 · Radiant 成像色度计实测</div>
        <h1 className="db-title-gradient mt-3 text-[40px] font-semibold leading-[1.08] tracking-tight sm:text-[60px]">均匀度排行榜</h1>
        <p className="mt-3 max-w-2xl text-[14px] leading-6 text-ink-2 sm:text-[15px] sm:leading-7">
          同一测试条件下按实测指标排序，并列的数值排名相同。勾选两台可以直接并排对比；没有这项数据的机型列在表格下方，不参与排名。
        </p>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
        <Pills
          label="测试条件"
          value={cond}
          onChange={(c) => update(c, by)}
          options={CONDITION_ORDER.map((c) => ({
            value: c,
            label: COND_LABEL[c],
          }))}
        />
        <Pills
          size="sm"
          label="排序指标"
          value={by}
          onChange={(b) => update(cond, b)}
          options={RANK_METRICS.map((m) => ({
            value: m,
            label: RANK_METRIC_META[m].label,
          }))}
        />
      </div>

      <div className="mt-6">
        {index.status === 'loading' || !ranking ? (
          index.status === 'error' ? (
            <Missing text="均匀度数据加载失败" detail={index.error} />
          ) : (
            <Loading className="h-[360px]" />
          )
        ) : ranking.rows.length === 0 ? (
          <Missing text={`${COND_LABEL[cond]} 还没有「${meta.label}」数据`} detail="换一个测试条件或指标看看。" />
        ) : (
          <div className="overflow-hidden rounded-[24px] bg-surface-1/80 ring-1 ring-inset ring-line">
            <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3 text-xs text-ink-3 sm:px-6">
              <span>
                {COND_LABEL[cond]} · {meta.label}（{meta.note}）
              </span>
              <span className="tabular-nums">{ranking.rows.length} 台</span>
            </div>
            <ol>
              {ranking.rows.map((r) => {
                const on = picked.includes(r.device.id);
                const slot = picked.indexOf(r.device.id);
                return (
                  <li
                    key={r.device.id}
                    className={cn(
                      'grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line/50 px-4 py-3 last:border-b-0 sm:grid-cols-[36px_minmax(0,220px)_minmax(0,1fr)_auto] sm:gap-x-5 sm:px-6',
                      on && 'bg-surface-2/70',
                    )}
                    data-testid="rank-row"
                  >
                    <div
                      className={cn('col-start-1 row-start-1 text-center text-[17px] font-semibold tabular-nums', r.rank <= 3 ? 'text-ink-1' : 'text-ink-3')}
                    >
                      {r.rank}
                    </div>
                    <div className="col-start-2 row-start-1 min-w-0">
                      <a
                        href={deviceHref(r.device.id, 'uniformity')}
                        className="block truncate text-[15px] font-medium text-ink-1 hover:text-accent-hover hover:underline"
                      >
                        {r.device.name.zh}
                        {r.display && <span className="ml-1.5 text-xs font-normal text-ink-3">{r.display === 'outer' ? '外屏' : '内屏'}</span>}
                      </a>
                      <div className="mt-0.5 truncate text-[11px] tabular-nums text-ink-3">
                        {r.typical !== null && <>典型 {fmtSig(r.typical)} nits</>}
                        {g20 && r.reference !== null && <> · 参考 {fmtSig(r.reference)} nits</>}
                        {by !== 'area' && r.areaUniformity !== null && <> · 面均匀性 {fmtFixed(r.areaUniformity, 1)} %</>}
                        {!r.hasMap && <> · 仅指标</>}
                      </div>
                    </div>
                    <div className="col-span-3 col-start-1 row-start-2 mt-2 flex items-center gap-3 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:mt-0">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                        <div
                          className={cn('h-full rounded-full', slot === 0 ? 'bg-slot-a' : slot === 1 ? 'bg-slot-b' : r.rank === 1 ? 'bg-accent' : 'bg-ink-3')}
                          style={{ width: barWidth(r.value) }}
                        />
                      </div>
                      <div className="w-[76px] text-right text-[16px] font-semibold tabular-nums text-ink-1">
                        {fmtFixed(r.value, meta.digits)}
                        <span className="ml-0.5 text-[11px] font-medium text-ink-3">{meta.unit}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(r.device.id)}
                      aria-pressed={on}
                      aria-label={`${on ? '取消' : '加入'}对比：${r.device.name.zh}`}
                      className={cn(
                        'col-start-3 row-start-1 inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors sm:col-start-4',
                        on ? 'bg-ink-1 text-canvas ring-transparent' : 'text-ink-3 ring-line hover:bg-surface-3 hover:text-ink-1',
                      )}
                    >
                      {on ? <Check size={13} aria-hidden /> : null}
                      {on ? (slot === 0 ? 'A' : 'B') : '对比'}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      {ranking && ranking.missing.length > 0 && (
        <div className="mt-6 rounded-[22px] px-5 py-4 text-xs leading-6 text-ink-3 ring-1 ring-inset ring-line/80">
          <span className="text-ink-2">没有这项数据（{ranking.missing.length} 台）：</span>
          {ranking.missing.map((d, i) => (
            <React.Fragment key={d.id}>
              {i > 0 && '、'}
              <a href={deviceHref(d.id)} className="hover:text-ink-1 hover:underline">
                {d.name.zh}
              </a>
              <span className="text-ink-4">
                （{['complete', 'metrics-only'].includes(d.availability.uniformity.status) ? '没测这一档' : STATUS_TEXT[d.availability.uniformity.status]}）
              </span>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Compare bar: appears once a row is ticked. */}
      {picked.length > 0 && (
        <div className="sticky bottom-4 z-30 mt-6 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-surface-3/95 py-2 pl-5 pr-2 text-[13px] text-ink-2 shadow-[0_12px_40px_rgba(0,0,0,0.5)] ring-1 ring-inset ring-line-strong backdrop-blur-xl">
            <span className="max-w-[56vw] truncate">
              {picked.map((id) => catalog.devices.find((d) => d.id === id)?.name.zh).join(' vs ')}
              {picked.length === 1 && <span className="text-ink-4"> · 再选一台</span>}
            </span>
            <a
              href={compareHref(picked)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 font-medium text-white hover:bg-accent-hover"
            >
              <ArrowLeftRight size={14} aria-hidden />
              对比
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
