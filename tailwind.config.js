/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces (dark instrument style, see docs/adr/0011)
        canvas: '#07090d',      // page / 3D background
        surface: {
          1: '#0b0e14',         // chart surface, panels
          2: '#11151d',         // raised panel
          3: '#171c26',         // controls
          4: '#1e2430',         // hover
        },
        line: {
          DEFAULT: '#232a36',   // hairline borders
          strong: '#2f3847',
        },
        ink: {
          1: '#f3f5f8',         // primary text
          2: '#b6bfcc',         // secondary text
          3: '#7d8796',         // muted / axis labels
          4: '#566070',         // disabled
        },
        accent: {
          DEFAULT: '#4c8dff',
          hover: '#6aa1ff',
          muted: 'rgba(76,141,255,0.14)',
          ring: 'rgba(76,141,255,0.45)',
        },
        safe: '#22c55e',        // SVM < 0.4 reference line
        critical: '#ef4444',    // SVM >= 1.0 reference line
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
