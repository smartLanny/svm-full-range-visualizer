/**
 * Tailwind config of the screen database page (db/, built by vite.db.config.ts).
 *
 * A copy of the workbench's design tokens (tailwind.config.js: dark instrument surfaces, ink, accent,
 * SVM reference colours, fonts) so both look like one product, kept in a separate file because
 * tailwind.config.js is an input of the offline release fingerprint (scripts/build-inputs.mjs).
 * Content: the database code plus the workbench components it renders (read-only imports).
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: {
    relative: true,
    files: [
      './db/index.html',
      './db/src/**/*.{ts,tsx}',
      './src/stats/Thumbnail.tsx',
      './src/stats/parts.tsx',
      './src/ui/**/*.{ts,tsx}',
    ],
  },
  theme: {
    extend: {
      colors: {
        // Same values as tailwind.config.js (docs/adr/0011).
        canvas: '#07090d',
        surface: {
          1: '#0b0e14',
          2: '#11151d',
          3: '#171c26',
          4: '#1e2430',
        },
        line: {
          DEFAULT: '#232a36',
          strong: '#2f3847',
        },
        ink: {
          1: '#f3f5f8',
          2: '#b6bfcc',
          3: '#7d8796',
          4: '#566070',
        },
        accent: {
          DEFAULT: '#4c8dff',
          hover: '#6aa1ff',
          muted: 'rgba(76,141,255,0.14)',
          ring: 'rgba(76,141,255,0.45)',
        },
        safe: '#22c55e',
        critical: '#ef4444',
        strong: '#d946ef',
        // Database only: the two compare slots (A, B), validated as a categorical pair on the dark
        // surfaces (dataviz validate_palette: CVD ΔE 27.5, normal-vision ΔE 32.1, contrast ≥ 3:1).
        slot: {
          a: '#4c8dff',
          b: '#e0703a',
        },
      },
      fontFamily: {
        sans: ['Inter', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', '"Source Han Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', '14px'],
      },
      boxShadow: {
        panel: '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)',
      },
    },
  },
  plugins: [],
};
