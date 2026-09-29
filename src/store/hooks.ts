import { useShallow } from 'zustand/react/shallow';
import type { SvmRecord } from '../types';
import { recordStyles, type RecordStyle } from '../data/colors';
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
