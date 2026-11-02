/**
 * Controlled vocabularies of the device catalog (data/devices.json). The generator copies them
 * into the catalog so the front end and db:check read the same labels.
 */

export const DATA_TYPES = ['svm', 'angle', 'uniformity', 'reflectance'];

export const DATA_TYPE_LABELS = {
  svm: { zh: '频闪', en: 'Flicker (SVM)' },
  angle: { zh: '可视角', en: 'Viewing angle' },
  uniformity: { zh: '均匀度', en: 'Uniformity' },
  reflectance: { zh: '反射率', en: 'Reflectance' },
};

/** Screen states. `unspecified` is never folded into `default`. */
export const STATES = {
  default: { zh: '默认', en: 'Default', note: '普通状态：未开防窥模式、未贴防窥膜或抗反膜。' },
  privacy: { zh: '防窥模式', en: 'Privacy mode', note: '机身内置的防窥显示模式。' },
  'privacy-film': { zh: '防窥膜', en: 'Privacy film' },
  'anti-reflective-film': { zh: '抗反膜', en: 'Anti-reflective film' },
  'screen-protector': { zh: '贴膜', en: 'Screen protector', note: '源记录只写「贴膜」，膜的种类未注明。' },
  unspecified: { zh: '原始样品 · 状态未注明', en: 'As measured · state not recorded', note: '源记录没有注明贴膜 / 防窥等状态；不并入「默认」。' },
  inner: { zh: '内屏', en: 'Inner display', note: '折叠屏源记录只按屏幕区分（未注明贴膜等状态）。' },
  outer: { zh: '外屏', en: 'Outer display', note: '折叠屏源记录只按屏幕区分（未注明贴膜等状态）。' },
};

/** How an entry's state was decided. */
export const STATE_BASIS = {
  source: { zh: '源数据标注', en: 'Stated by the source' },
  convention: { zh: '源数据未标注，按常规测量状态记为默认（待确认）', en: 'Not stated; recorded as the usual test state (to confirm)' },
};

export const DISPLAYS = {
  main: { zh: '主屏', en: 'Main display' },
  inner: { zh: '内屏', en: 'Inner display' },
  outer: { zh: '外屏', en: 'Outer display' },
};

/** Per device and data type. */
export const AVAILABILITY = {
  complete: { zh: '完整', en: 'Complete', note: '有可视化数据（热力图、曲线或矩阵）。' },
  partial: { zh: '部分已测', en: 'Partly measured', note: '部分屏幕或状态已测，其余未测。' },
  'metrics-only': { zh: '仅指标', en: 'Metrics only', note: '只有数值指标，没有热力图或曲线。' },
  'pending-import': { zh: '已测待导入', en: 'Measured, not imported', note: '源数据存在，但还没导入本库。' },
  'not-measured': { zh: '未测', en: 'Not measured', note: '本库没有这项测量。' },
};

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
