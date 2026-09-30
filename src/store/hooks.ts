import { useShallow } from 'zustand/react/shallow';
import type { Dataset, SvmRecord } from '../types';
import { recordStyles, type RecordStyle } from '../data/colors';
import { processRecord, type ProcessedRecord } from '../data/denoise';
import { useMemo } from 'react';
import { useAppStore } from './appStore';

/** Records not hidden, in record order (stable reference while unchanged). */
export function useVisibleRecords(): SvmRecord[] {
  return useAppStore(useShallow((s) => s.records.filter((r) => !s.hiddenIds.includes(r.id))));
}

export function useActiveRecord(): SvmRecord | null {
  return useAppStore((s) => s.records.find((r) => r.id === s.activeId) ?? null);
}

export function useCompareRecord(): SvmRecord | null {
  return useAppStore((s) => s.records.find((r) => r.id === s.compareId) ?? null);
}

/** Color + dash per record id (device color, mode dash). Covers ALL records so colors never shift when some are hidden. */
export function useRecordStyles(): Map<string, RecordStyle> {
  const records = useAppStore((s) => s.records);
  const overrides = useAppStore((s) => s.deviceColors);
  return useMemo(() => recordStyles(records, overrides), [records, overrides]);
}

/** Current denoise setting (docs/adr/0012 addendum). */
export function useDenoise(): boolean {
  return useAppStore((s) => s.denoise);
}

/**
 * A record processed under the current denoise setting: `.record` is what to draw, `.notes` /
 * `.noteGrid` / `.noteAt()` explain processed cells, `.summary` counts them. Stable identity
 * per (record, setting); null for null.
 */
export function useProcessed<T extends Dataset>(rec: T | null): ProcessedRecord<T> | null {
  const denoise = useDenoise();
  return rec ? processRecord(rec, { denoise }) : null;
}

/** The record to draw under the current denoise setting (null for null). */
export function useDisplayRecord<T extends Dataset>(rec: T | null): T | null {
  return useProcessed(rec)?.record ?? null;
}

/** Records to draw under the current denoise setting, same order (stable while inputs are). */
export function useDisplayRecords<T extends Dataset>(records: T[]): T[] {
  const denoise = useDenoise();
  return useMemo(() => records.map((r) => processRecord(r, { denoise }).record), [records, denoise]);
}
