/**
 * Readers for the migrated atlas data (data/uniformity, data/reflectance) shared by the
 * migration script, the catalog generator and db:check. They only read and describe the files;
 * nothing here changes a value.
 */

/** Reflectance curves are instrument samples at 400–700 nm, 10 nm apart (31 points). */
export const REFLECTANCE_GRID = { fromNm: 400, toNm: 700, stepNm: 10, points: 31 };

/** Curve key in data/reflectance/index.json → spectrum key in raw/phone-samples.json. */
export const CURVE_METHOD = { total: 'SCI', diffuse: 'SCE' };

/**
 * Every heatmap the uniformity index references:
 * [{ phoneId, condition, kind ('luminance' | 'colorTemperature'), asset, assetSha256 }].
 */
export function uniformityAssets(index) {
  const out = [];
  for (const phone of index.phones ?? []) {
    for (const cond of phone.conditions ?? []) {
      for (const [kind, map] of Object.entries(cond.maps ?? {})) {
        out.push({ phoneId: phone.id, condition: cond.id, kind, asset: map.asset, assetSha256: map.assetSha256 });
      }
    }
  }
  return out;
}

/** Problems with one curve's sampling grid (empty when it is the 31-point 400–700 nm grid). */
export function curveGridProblems(samples) {
  const g = REFLECTANCE_GRID;
  if (!Array.isArray(samples)) return ['samples 不是数组'];
  const problems = [];
  if (samples.length !== g.points) problems.push(`应有 ${g.points} 个点，实际 ${samples.length} 个`);
  samples.forEach((s, i) => {
    const wl = g.fromNm + i * g.stepNm;
    if (!Array.isArray(s) || s.length !== 2) { problems.push(`第 ${i + 1} 个点格式错误`); return; }
    if (i < g.points && s[0] !== wl) problems.push(`第 ${i + 1} 个点波长 ${s[0]} nm，应为 ${wl} nm`);
    if (typeof s[1] !== 'number' || !Number.isFinite(s[1])) problems.push(`${s[0]} nm 的反射率不是有限数值`);
    else if (s[1] < 0 || s[1] > 100) problems.push(`${s[0]} nm 的反射率 ${s[1]} % 超出 0–100 %`);
  });
  return problems;
}

/**
 * Point-by-point comparison of every index curve with the raw instrument fractions it was made
 * from (reflectance % = fraction × 100). Returns { conditions, curves, matched, problems[] }.
 */
export function compareReflectanceToRaw(index, raw, tolerance = 1e-9) {
  const byId = new Map((raw.samples ?? []).map((s) => [String(s.recordId), s]));
  const factor = raw.percentConversionFactor ?? 100;
  const problems = [];
  let conditions = 0, curves = 0, matched = 0;
  for (const phone of index.phones ?? []) {
    for (const cond of phone.conditions ?? []) {
      conditions++;
      const where = `${phone.id} / ${cond.id}`;
      const sample = byId.get(String(cond.rawSampleId));
      if (!sample) { problems.push(`${where}: raw/phone-samples.json 中没有样品 ${cond.rawSampleId}`); continue; }
      if (sample.phoneId !== phone.id || sample.conditionId !== cond.id) {
        problems.push(`${where}: 原始样品 ${cond.rawSampleId} 属于 ${sample.phoneId} / ${sample.conditionId}`);
      }
      if (sample.measuredAt !== cond.measuredAt) problems.push(`${where}: 测量时间 ${cond.measuredAt} 与原始样品 ${sample.measuredAt} 不一致`);
      for (const [key, method] of Object.entries(CURVE_METHOD)) {
        const curve = cond.curves?.[key];
        if (!curve) { problems.push(`${where}: 缺少 ${key}（${method}）曲线`); continue; }
        curves++;
        const spec = sample.spectra?.[method];
        const fr = spec?.reflectanceFractions;
        if (!Array.isArray(fr)) { problems.push(`${where}: 原始样品缺少 ${method} 光谱`); continue; }
        const [from] = spec.rangeNm ?? [];
        const step = spec.sampleStepNm;
        let ok = fr.length === curve.samples?.length;
        if (!ok) problems.push(`${where} ${method}: 点数 ${curve.samples?.length} 与原始 ${fr.length} 不一致`);
        else {
          for (let i = 0; i < fr.length; i++) {
            const [wl, pct] = curve.samples[i];
            if (wl !== from + i * step || Math.abs(pct - fr[i] * factor) > tolerance) {
              problems.push(`${where} ${method}: ${wl} nm 为 ${pct} %，原始读数 ${fr[i]} × ${factor} = ${fr[i] * factor}`);
              ok = false;
              break;
            }
          }
        }
        if (ok) matched++;
      }
    }
  }
  return { conditions, curves, matched, problems };
}
