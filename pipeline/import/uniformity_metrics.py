#!/usr/bin/env python3
"""Import uniformity metrics (the video project's uniformity_metrics.json) into data/uniformity/index.json.

    python3 -I pipeline/import/uniformity_metrics.py --options <options.json>
        [--metrics <uniformity_metrics.json>] [--root <repo>] [--batch <batch id>]
        [--source-name <path relative to NAS_ROOT>] [--audit <audit.json>] [--dry-run]

Input format (as read by the atlas's scripts/uniformity/export_maps.py): a JSON array of rows
  {"id": "<source id, e.g. ip17pm>", "level": "300" | "100" | "10", "kind": "lum" | "cct",
   "cond": "" (default condition; other values are other test conditions),
   "typ": typical value, "u9": nine-point %, "ua": area %, "dev10": area deviating >10 % (lum),
   "d9": nine-point spread K, "da": area spread K (cct)}
Only default-condition rows ("cond" empty) are imported; other rows are listed in the audit.

Options (inputs[].options in a batch file):
  {"devices": {"iphone-17-pro-max": {"sourceId": "ip17pm"}, "honor-magic-v5": {"sourceId": "mv5", "display": "outer"}} | ["iphone-17-pro-max"],
   "white": {"xiaomi-17-ultra": {"100": {"nits": 101.2, "note": "复测白场"}}},
   "replace": false}

What it does, per device listed in "devices":
  * a device that already has heatmaps (index.json "phones"): the metrics must equal the ones the
    heatmaps were made with (same rounding as export_maps.py); a difference is an error, because the
    heatmaps would then disagree with the numbers (re-export them first). Nothing is written.
  * any other device: its conditions are written as metrics only (no heatmap) into "metricsOnly";
    a device listed under "notRecorded" moves to "metricsOnly". Existing different numbers are an
    error unless "replace": true.
"white" adds the measured full-white luminance at a condition's brightness setting:
"whiteMeasuredNits" (+ "whiteMeasuredSource") on that condition, for the Gamma 2.2 reference.

The file is rewritten only when its content changes (then in the atlas format: 2-space indent,
UTF-8, trailing newline). Prints one JSON result object on stdout. Standard library only.
"""
import argparse
import copy
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = Path("data/uniformity/index.json")
OVERRIDES = Path("data/catalog-overrides.json")
LEVELS = {
    "300": {"label": "300 nits 白场", "pattern": "全白场", "referenceNits": 300},
    "100": {"label": "100 nits G20", "pattern": "G20", "referenceNits": 100},
    "10": {"label": "10 nits G20", "pattern": "G20", "referenceNits": 10},
}
KINDS = {"lum": "luminance", "cct": "colorTemperature"}
# rounding of scripts/uniformity/export_maps.py
LUM_DIGITS = {"typical": 6, "ninePointUniformityPct": 4, "areaUniformityPct": 4, "deviation10PctArea": 4}
CCT_DIGITS = {"typical": 3, "ninePointSpreadK": 3, "areaSpreadK": 3}
LUM_FIELDS = {"typical": "typ", "ninePointUniformityPct": "u9", "areaUniformityPct": "ua", "deviation10PctArea": "dev10"}
CCT_FIELDS = {"typical": "typ", "ninePointSpreadK": "d9", "areaSpreadK": "da"}
G20 = 20 / 255
GAMMA_RANGE = (1.6, 2.8)


class ImportError_(Exception):
    pass


def fail(message):
    raise ImportError_(message)


def num(value, where):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        fail(f"{where}: 不是数字（{value!r}）")
    try:
        out = float(value)
    except ValueError:
        fail(f"{where}: 不是数字（{value!r}）")
    if not math.isfinite(out):
        fail(f"{where}: 不是有限数值（{value!r}）")
    return out


def close(stored, new, digits):
    return round(new, digits) == stored or abs(new - stored) <= 0.5 * 10 ** -digits + 1e-9


def metric_block(row, kind, where):
    if kind == "lum":
        out = {"typical": round(num(row.get("typ"), f"{where}.typ"), 6), "unit": "nit"}
        for key, field in list(LUM_FIELDS.items())[1:]:
            out[key] = round(num(row.get(field), f"{where}.{field}"), LUM_DIGITS[key])
        if not out["typical"] > 0:
            fail(f"{where}: 典型亮度 {out['typical']} 应大于 0")
        for key in ("ninePointUniformityPct", "areaUniformityPct", "deviation10PctArea"):
            if not 0 <= out[key] <= 100:
                fail(f"{where}: {key} = {out[key]} 不在 0–100 %")
    else:
        out = {"typical": round(num(row.get("typ"), f"{where}.typ"), 3), "unit": "K"}
        for key, field in list(CCT_FIELDS.items())[1:]:
            out[key] = round(num(row.get(field), f"{where}.{field}"), CCT_DIGITS[key])
        if not 1000 < out["typical"] < 20000 or out["ninePointSpreadK"] < 0 or out["areaSpreadK"] < 0:
            fail(f"{where}: 色温指标不合理（典型 {out['typical']} K，九点差 {out['ninePointSpreadK']} K，面差 {out['areaSpreadK']} K）")
    return out


def compare_block(stored, row, kind):
    """Field names whose stored (rounded) value differs from the source row."""
    fields, digits = (LUM_FIELDS, LUM_DIGITS) if kind == "lum" else (CCT_FIELDS, CCT_DIGITS)
    out = []
    for key, field in fields.items():
        value = num(row.get(field), field)
        if key not in stored or not close(stored[key], value, digits[key]):
            out.append(f"{key}（库内 {stored.get(key)}，新文件 {value}）")
    return out


def load_rows(raw):
    try:
        rows = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"指标文件不是 UTF-8 JSON：{exc}")
    if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
        fail("指标文件应是对象数组（uniformity_metrics.json 格式）")
    default, other = {}, []
    for i, row in enumerate(rows):
        sid, level, kind = row.get("id"), row.get("level"), row.get("kind")
        if not isinstance(sid, str) or not sid:
            fail(f"第 {i + 1} 行没有 id")
        if isinstance(level, int) and not isinstance(level, bool):
            level = str(level)
        if not isinstance(level, str) or kind not in KINDS:
            fail(f"第 {i + 1} 行（{sid}）的 level / kind 无法识别：{row.get('level')!r} / {kind!r}")
        if row.get("cond") not in ("", None):
            other.append({"id": sid, "level": level, "kind": kind, "cond": row.get("cond")})
            continue
        key = (sid, level, kind)
        if key in default:
            fail(f"指标文件里 {sid} / {level} / {kind} 的默认条件出现两次")
        default[key] = row
    return default, other


def screens_of(index, device_id):
    return [e for g in ("phones", "metricsOnly") for e in index.get(g, []) if e.get("id") == device_id]


def single_screen(index, device_id, what):
    """This importer addresses a device by id: refuse a device with one entry per screen (inner / outer)."""
    if len(screens_of(index, device_id)) > 1:
        fail(f"{device_id} 有内外两块屏各一条均匀度记录，{what}还不支持分屏：请用 uniformity-maps 导入（options 里写 display）")


def find_condition(index, device_id, cond_id):
    single_screen(index, device_id, "白场读数")
    for group in ("phones", "metricsOnly"):
        for phone in index.get(group, []):
            if phone.get("id") == device_id:
                for c in phone.get("conditions", []):
                    if c.get("id") == cond_id:
                        return c
    return None


def run(args):
    root = Path(args.root).resolve()
    options = json.loads(Path(args.options).read_text(encoding="utf-8")) if args.options else {}
    unknown = set(options) - {"devices", "white", "replace", "note"}
    if unknown:
        fail(f"options 有未知字段：{sorted(unknown)}")
    replace = options.get("replace") is True
    index_path = root / INDEX
    index_raw = index_path.read_bytes()
    index = json.loads(index_raw)
    result_index = copy.deepcopy(index)
    overrides = json.loads((root / OVERRIDES).read_text(encoding="utf-8"))
    names = {d["id"]: d["name"]["zh"] for d in overrides.get("devices", [])}

    # source id ↔ device, from what the index already knows
    known_source = {}
    for phone in index.get("phones", []):
        for c in phone.get("conditions", []):
            for m in (c.get("maps") or {}).values():
                key = m.get("sourceKey", "")
                if key.count("_") >= 2:
                    known_source.setdefault(phone["id"], key.split("_", 2)[2])
    for m in index.get("metricsOnly", []):
        if m.get("metricSourceId"):
            known_source[m["id"]] = m["metricSourceId"]

    devices = options.get("devices") or {}
    if isinstance(devices, list):
        devices = {d: {} for d in devices}
    if not isinstance(devices, dict):
        fail("options.devices 应是机型 id 列表或 {机型 id: {sourceId}} 对象")
    if devices and not args.metrics:
        fail("options.devices 需要指标文件（--metrics）")
    if args.metrics and not devices:
        fail("给了指标文件，但 options.devices 没有列出要导入的机型（不会把整个文件都导进来）")

    audit_devices, changelog, warnings = [], [], []
    source = None
    skipped_other = []
    if args.metrics:
        raw = Path(args.metrics).read_bytes()
        source = {"file": args.source_name or Path(args.metrics).name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        rows, other = load_rows(raw)
        source_ids = sorted({k[0] for k in rows})
        for device_id, spec in devices.items():
            if device_id not in names:
                fail(f"机型 {device_id} 不在 data/catalog-overrides.json 中：先在 devices 里加上它")
            spec = spec or {}
            single_screen(result_index, device_id, "指标导入")
            sid = spec.get("sourceId") or known_source.get(device_id)
            if not sid:
                fail(f"{device_id}: 不知道它在指标文件里的 id，请在 options.devices 里写 sourceId（文件里有：{'、'.join(source_ids)}）")
            if known_source.get(device_id) and known_source[device_id] != sid and not replace:
                fail(f"{device_id}: 库里记录的源 id 是 {known_source[device_id]}，options 写的是 {sid}（确需改源 id 请写 \"replace\": true）")
            mine = {k: v for k, v in rows.items() if k[0] == sid}
            if not mine:
                fail(f"指标文件里没有 {sid}（{device_id}）的默认条件记录（文件里有：{'、'.join(source_ids)}）")
            for k in mine:
                if k[1] not in LEVELS:
                    fail(f"{sid}: 档位 {k[1]} 不是 {' / '.join(LEVELS)}，本导入器不认识")
            skipped_other += [o for o in other if o["id"] == sid]
            phone = next((p for p in result_index.get("phones", []) if p["id"] == device_id), None)
            if phone:
                # heatmap device: verify only
                have = {(c["id"], kind) for c in phone["conditions"] for kind in KINDS if KINDS[kind] in c.get("metrics", {})}
                extra = sorted(set((k[1], k[2]) for k in mine) - have)
                if extra:
                    fail(f"{device_id} 已有热力图；指标文件多出 {extra}，没有对应热力图的档位不能混进来")
                diffs = []
                for c in phone["conditions"]:
                    for kind, name in KINDS.items():
                        if name not in c.get("metrics", {}):
                            continue
                        row = mine.get((sid, c["id"], kind))
                        if row is None:
                            fail(f"{device_id}: 指标文件缺少 {c['id']} / {kind}（库里有热力图）")
                        diffs += [f"{c['id']} {kind} {d}" for d in compare_block(c["metrics"][name], row, kind)]
                if diffs:
                    fail(f"{device_id} 的热力图是按旧指标导出的，新文件的指标不同：{'；'.join(diffs)}。热力图需要先重新导出，本导入器不改有热力图的机型")
                audit_devices.append({"device": device_id, "sourceId": sid, "status": "verified-unchanged",
                                      "conditions": [c["id"] for c in phone["conditions"]]})
                continue
            conditions = []
            for level, meta in LEVELS.items():
                lum, cct = mine.get((sid, level, "lum")), mine.get((sid, level, "cct"))
                if lum is None and cct is None:
                    continue
                if lum is None:
                    fail(f"{sid} / {level}: 只有色温没有亮度记录")
                metrics = {"luminance": metric_block(lum, "lum", f"{sid}/{level}/lum")}
                if cct is not None:
                    metrics["colorTemperature"] = metric_block(cct, "cct", f"{sid}/{level}/cct")
                conditions.append({"id": level, **meta, "metrics": metrics})
            entry = next((m for m in result_index.setdefault("metricsOnly", []) if m["id"] == device_id), None)
            status = "created"
            if entry is None:
                was_not_recorded = any(m["id"] == device_id for m in result_index.get("notRecorded", []))
                result_index["notRecorded"] = [m for m in result_index.get("notRecorded", []) if m["id"] != device_id]
                entry = {"id": device_id, "name": names[device_id], "metricSourceId": sid, "conditions": []}
                result_index["metricsOnly"].append(entry)
                if was_not_recorded:
                    warnings.append(f"{device_id} 原记为「未测」（notRecorded），现有指标，改为仅指标")
            if spec.get("display"):
                if spec["display"] not in ("main", "inner", "outer"):
                    fail(f"{device_id}: display 应是 main / inner / outer（写的是 {spec['display']!r}）")
                entry["display"] = spec["display"]
            old = entry.get("conditions") or []
            stripped_old = [{k: v for k, v in c.items() if not k.startswith("whiteMeasured")} for c in old]
            if old and stripped_old == conditions:
                status = "unchanged"
            elif old and not replace:
                fail(f"{device_id} 的均匀度指标已存在且不同；原始数据不覆盖。确需替换请在 options 里写 \"replace\": true")
            elif old:
                status = "replaced"
            if status != "unchanged":
                # keep white readings already attached to a condition that stays
                whites = {c["id"]: {k: v for k, v in c.items() if k.startswith("whiteMeasured")} for c in old}
                entry["conditions"] = [{**c, **whites.get(c["id"], {})} for c in conditions]
                entry["metricSourceId"] = sid
                entry["metricsSource"] = {**source, **({"batch": args.batch} if args.batch else {})}
                levels = "、".join(f"{c['id']} nits" for c in conditions)
                verb = "新增" if status == "created" else "替换"
                changelog.append(f"均匀度：{names[device_id]} {verb}仅指标数据（{levels}，无热力图；源 id {sid}）")
            audit_devices.append({"device": device_id, "sourceId": sid, "status": status,
                                  "conditions": [c["id"] for c in conditions],
                                  "metrics": {c["id"]: c["metrics"] for c in conditions}})

    white_audit = []
    for device_id, by_cond in (options.get("white") or {}).items():
        if not isinstance(by_cond, dict):
            fail(f"options.white.{device_id} 应是 {{档位: {{nits, note}}}}")
        for cond_id, reading in by_cond.items():
            where = f"白场 {device_id} / {cond_id}"
            if not isinstance(reading, dict) or set(reading) - {"nits", "note", "allowUnusualGamma"}:
                fail(f"{where}: 应写成 {{\"nits\": 数值, \"note\": \"说明\"}}")
            nits = num(reading.get("nits"), where)
            if not nits > 0:
                fail(f"{where}: 白场亮度应大于 0")
            if not isinstance(reading.get("note"), str) or not reading["note"].strip():
                fail(f"{where}: 请在 note 里写明怎么测的（仪器、日期、样机）")
            cond = find_condition(result_index, device_id, cond_id)
            if cond is None:
                fail(f"{where}: 库里没有这台机型的这一档均匀度数据，白场没有可挂的条件")
            info = {"device": device_id, "condition": cond_id, "whiteMeasuredNits": nits}
            ref = cond.get("referenceNits")
            typical = (cond.get("metrics", {}).get("luminance") or {}).get("typical")
            if cond.get("pattern") == "G20" and typical:
                gamma = math.log(typical / nits) / math.log(G20)
                info["gammaEffective"] = round(gamma, 4)
                info["gamma22ReferenceNits"] = round(nits * G20 ** 2.2, 6)
                if not GAMMA_RANGE[0] <= gamma <= GAMMA_RANGE[1] and reading.get("allowUnusualGamma") is not True:
                    fail(f"{where}: 由白场 {nits} nits 和 G20 典型亮度 {typical} nits 算出 γ_eff = {gamma:.3f}，"
                         f"不在 {GAMMA_RANGE[0]}–{GAMMA_RANGE[1]}，白场或单位疑似写错（确认无误可加 \"allowUnusualGamma\": true）")
            if ref and not 0.7 <= nits / ref <= 1.3:
                warnings.append(f"{where}: 实测白场 {nits} nits 与设定 {ref} nits 相差超过 30 %")
            if "whiteMeasuredNits" in cond and cond["whiteMeasuredNits"] != nits and not replace:
                fail(f"{where}: 已有实测白场 {cond['whiteMeasuredNits']} nits；要改请写 \"replace\": true")
            status = "unchanged" if cond.get("whiteMeasuredNits") == nits else ("replaced" if "whiteMeasuredNits" in cond else "created")
            if status != "unchanged":
                cond["whiteMeasuredNits"] = nits
                cond["whiteMeasuredSource"] = {**({"batch": args.batch} if args.batch else {}), "note": reading["note"].strip()}
                changelog.append(f"均匀度：{names.get(device_id, device_id)} {cond_id} nits 档{'记录' if status == 'created' else '更正'}实测白场 {nits} nits")
            info["status"] = status
            white_audit.append(info)

    changed = result_index != index
    new_raw = (json.dumps(result_index, ensure_ascii=False, indent=2) + "\n").encode("utf-8") if changed else index_raw
    if changed and not args.dry_run:
        index_path.write_bytes(new_raw)
    audit = {
        "importer": "pipeline/import/uniformity_metrics.py",
        "source": source,
        "devices": audit_devices,
        "white": white_audit,
        "skippedNonDefaultRows": skipped_other,
        "index": {"path": INDEX.as_posix(), "sha256Before": hashlib.sha256(index_raw).hexdigest(),
                  "sha256After": hashlib.sha256(new_raw).hexdigest(), "changed": changed},
        "rounding": "Same as the atlas's scripts/uniformity/export_maps.py: luminance typical 6 decimals, percentages 4, colour temperature 3.",
        "warnings": warnings,
    }
    if args.audit and not args.dry_run:
        Path(args.audit).parent.mkdir(parents=True, exist_ok=True)
        Path(args.audit).write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for d in audit_devices:
        print(f"  {d['status']:18} {d['device']}（{d['sourceId']}）：{'、'.join(d['conditions'])}", file=sys.stderr)
    for w in white_audit:
        print(f"  {w['status']:18} 白场 {w['device']} / {w['condition']}：{w['whiteMeasuredNits']} nits" + (f"，γ_eff {w['gammaEffective']}" if "gammaEffective" in w else ""), file=sys.stderr)
    for w in warnings:
        print(f"  ! {w}", file=sys.stderr)
    return {"importer": "uniformity_metrics", "ok": True, "dryRun": bool(args.dry_run),
            "input": source, "changedFiles": [INDEX.as_posix()] if changed else [],
            "requiresStandaloneRebuild": False, "changelog": changelog, "warnings": warnings, "audit": audit}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--metrics", help="视频项目的 uniformity_metrics.json")
    parser.add_argument("--options", help="选项 JSON（批次文件里 inputs[].options 的内容）")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--batch", help="批次 id，写进来源记录")
    parser.add_argument("--source-name", help="审计里记录的源文件名（相对 NAS_ROOT 的路径）")
    parser.add_argument("--audit", help="审计 JSON 输出路径")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = run(args)
    except ImportError_ as exc:
        print(f"均匀度导入失败：{exc}", file=sys.stderr)
        print(json.dumps({"importer": "uniformity_metrics", "ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
