import React from 'react';
import { Download } from 'lucide-react';
import { Button } from '../ui';

/** Header entry point for PNG / video export. Implemented by the export module. */
export default function ExportButton() {
  return (
    <Button size="sm" variant="secondary" icon={<Download size={14} />} disabled>
      导出
    </Button>
  );
}
