import type { StringsModule } from '../index';

// Strings owned by the chart2d module. Keys are addressed as 'chart2d.<path>'.
// Titles contain "{v}" where the (live) slice value is drawn with tabular digits.
const strings: StringsModule = {
  zh: {
    title: {
      gray: 'SVM 测试（灰阶 G{v}）',
      level: 'SVM 测试（档位亮度 {v} nits）',
    },
    axisMode: {
      standard: '标准坐标',
      adaptive: '自适应横轴',
      free: '自由坐标',
    },
    range: {
      nits: '亮度 {a}–{b} nits',
      gray: '灰阶 {a}–{b}',
      svm: 'SVM {a}–{b}',
      auto: '自动范围',
    },
    axis: {
      xGray: '实测亮度（nits，对数坐标）',
      xLevel: '灰阶',
      y: 'SVM',
    },
    sweep: {
      gray: '灰阶扫描 G255→G50',
      level: '档位亮度扫描 500→2 nits',
    },
    toolbar: {
      play: '播放扫描',
      stop: '结束扫描',
      table: '表格',
      tableTitle: '显示/隐藏数据表格',
    },
    table: {
      title: '截面数据',
      record: '记录',
      copyTsv: '复制 TSV',
      copied: '已复制 TSV 到剪贴板',
      copyFailed: '复制失败',
      empty: '没有可显示的数据',
      note: '数值为曲线在各采样点处的插值 SVM；空白表示该记录在此处无数据。',
      colNits: '{v} nits',
      colGray: 'G{v}',
    },
    tooltip: {
      nits: '{v} nits',
      gray: 'G{v}',
    },
    empty: {
      title: '没有可显示的记录',
      hint: '在记录列表中勾选要对比的记录，或点击下方按钮全部显示。',
      hintNone: '导入一条测量记录后即可在这里对比曲线。',
      showAll: '全部显示',
      canvas: '没有可显示的记录',
    },
    aria: '2D 截面对比图：{title}',
  },
  en: {
    title: {
      gray: 'SVM test (gray G{v})',
      level: 'SVM test (level luminance {v} nits)',
    },
    axisMode: {
      standard: 'Standard axes',
      adaptive: 'Adaptive x-axis',
      free: 'Free axes',
    },
    range: {
      nits: 'Luminance {a}–{b} nits',
      gray: 'Gray {a}–{b}',
      svm: 'SVM {a}–{b}',
      auto: 'Auto range',
    },
    axis: {
      xGray: 'Measured luminance (nits, log)',
      xLevel: 'Gray level',
      y: 'SVM',
    },
    sweep: {
      gray: 'Gray sweep G255→G50',
      level: 'Level sweep 500→2 nits',
    },
    toolbar: {
      play: 'Play sweep',
      stop: 'End sweep',
      table: 'Table',
      tableTitle: 'Show / hide the data table',
    },
    table: {
      title: 'Slice data',
      record: 'Record',
      copyTsv: 'Copy TSV',
      copied: 'TSV copied to clipboard',
      copyFailed: 'Copy failed',
      empty: 'No data to show',
      note: 'Values are each curve’s interpolated SVM at the sample; blank = no data there for that record.',
      colNits: '{v} nits',
      colGray: 'G{v}',
    },
    tooltip: {
      nits: '{v} nits',
      gray: 'G{v}',
    },
    empty: {
      title: 'No records to show',
      hint: 'Tick records in the record list to compare them, or show them all.',
      hintNone: 'Import a measurement record to compare curves here.',
      showAll: 'Show all',
      canvas: 'No records to show',
    },
    aria: '2D cross-section chart: {title}',
  },
};
export default strings;
