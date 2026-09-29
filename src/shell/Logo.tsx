import React from 'react';

/** App mark (same drawing as public/icon.svg), inline so it works offline and in the single-file build. */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect width="64" height="64" rx="14" fill="#0b0e14" />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.25" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1.5" />
      <rect x="10" y="38" width="8" height="16" rx="2" fill="#4c8dff" />
      <rect x="22" y="28" width="8" height="26" rx="2" fill="#6aa1ff" />
      <rect x="34" y="18" width="8" height="36" rx="2" fill="#f5b041" />
      <rect x="46" y="10" width="8" height="44" rx="2" fill="#ef5a5a" />
    </svg>
  );
}
