import React, { useEffect, useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useT } from '../i18n';
import { deviceOrder } from '../data/colors';
import type { SvmRecord } from '../types';
import { Button, Dialog } from '../ui';
import { FormRow, TextInput, useFieldId } from './controls';

const derivedName = (device: string, mode: string) => (mode.trim() ? `${device.trim()} ${mode.trim()}` : device.trim());

/** Edit a record's name / device / mode. The name follows device + mode until edited by hand. */
export function EditRecordDialog({ record, onClose }: { record: SvmRecord | null; onClose: () => void }) {
  const t = useT();
  const records = useAppStore((s) => s.records);
  const devices = useMemo(() => deviceOrder(records), [records]);
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [mode, setMode] = useState('');
  const [nameAuto, setNameAuto] = useState(false);
  const ids = {
    name: useFieldId('edit-name'),
    device: useFieldId('edit-device'),
    mode: useFieldId('edit-mode'),
    list: useFieldId('devices'),
  };

  useEffect(() => {
    if (!record) return;
    setName(record.name);
    setDevice(record.device);
    setMode(record.mode);
    setNameAuto(record.name === derivedName(record.device, record.mode));
  }, [record]);

  const valid = device.trim().length > 0 && name.trim().length > 0;
  const save = () => {
    if (!record || !valid) return;
    useAppStore.getState().updateRecord(record.id, {
      name: name.trim(),
      device: device.trim(),
      mode: mode.trim(),
    });
    onClose();
  };

  return (
    <Dialog
      open={!!record}
      onClose={onClose}
      title={t('shell.edit.title')}
      icon={<Pencil size={14} className="text-ink-3" />}
      widthClass="max-w-md"
      closeLabel={t('common.close')}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" disabled={!valid} onClick={save} data-testid="edit-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <FormRow label={t('shell.edit.device')} hint={t('shell.edit.deviceHint')} htmlFor={ids.device}>
          <TextInput
            id={ids.device}
            list={ids.list}
            value={device}
            autoFocus
            data-testid="edit-device"
            onChange={(e) => {
              setDevice(e.target.value);
              if (nameAuto) setName(derivedName(e.target.value, mode));
            }}
          />
          <datalist id={ids.list}>
            {devices.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </FormRow>
        <FormRow label={t('shell.edit.mode')} hint={t('shell.edit.modeHint')} htmlFor={ids.mode}>
          <TextInput
            id={ids.mode}
            value={mode}
            data-testid="edit-mode"
            onChange={(e) => {
              setMode(e.target.value);
              if (nameAuto) setName(derivedName(device, e.target.value));
            }}
          />
        </FormRow>
        <FormRow label={t('shell.edit.name')} htmlFor={ids.name}>
          <TextInput
            id={ids.name}
            value={name}
            data-testid="edit-name"
            onChange={(e) => {
              setName(e.target.value);
              setNameAuto(false);
            }}
          />
        </FormRow>
        {record?.source === 'bundled' && <p className="text-2xs text-ink-3">{t('shell.edit.bundledNote')}</p>}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
