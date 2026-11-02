#!/usr/bin/env python3
"""Reflectance from the ThreeNH instrument XML: whitelisted phone samples → raw readings → index.

XML only. The atlas's raw_ingest.py built the index through rebuild.py (PNG digitising with NumPy and
Pillow, PNG sources since dropped); this script builds data/reflectance/index.json straight from
data/reflectance/raw/phone-samples.json, with the standard library.

    python3 -I pipeline/import/reflectance_xml.py import --xml <反射率.xml> [--options <options.json>]
        [--root <repo>] [--source-name <path relative to NAS_ROOT>] [--batch <id>] [--audit <file>] [--dry-run]
    python3 -I pipeline/import/reflectance_xml.py index [--pure] [--compare <index.json>] [--root <repo>] [--dry-run]
    python3 -I pipeline/import/reflectance_xml.py verify --xml <反射率.xml> [--root <repo>]

import   Reads every approved sample from the XML: the samples already in raw/phone-samples.json
         (their readings must be unchanged, point for point) plus options.add (new approved samples,
         see below). Writes raw/phone-samples.json, source-manifest.json "rawSource" and index.json,
         each only when it changes.
index    Regenerates index.json from raw/phone-samples.json. By default the existing index is the
         base, so corroboration fields from the retired PNG route (legendLabelPercent,
         corroboratingPngSourceId, sourcePlotBounds, corroboration, …) stay as they are and an
         unchanged raw file gives a byte-identical index. --pure starts from nothing (XML only);
         --compare lists the differences to another index and exits 1 if any field other than the
         PNG-related ones differs.
verify   Independent check (does not use the import functions): every published point equals the
         XML fraction × 100.

The whitelist: the XML holds other projects' samples (tablets, monitors, …). Only samples listed by
recordId AND expectedName are read. options.add entries:
  {"recordTag": "Standard", "recordId": "431", "expectedName": "<Name in the XML, exactly>",
   "phoneId": "<catalog id>", "phoneName": "<name>", "conditionId": "as-measured",
   "conditionLabel": "原始样品 · 状态未注明", "panel": "<optional panel code>"}

XML schema (from the atlas's raw_ingest.py / verify_xml.py; NO real file has been run through this
script yet, see pipeline/README.md): root <ThreeNHJob Version="…">; records <Standard ID="…" Name="…"
DateTime="…" IsTransmission="False" Instrument="…" OpticalStruct="…" MeasurementCaliber="…" UV="…"
LensPosition="…"> anywhere below the root; children <SCI IsReflectance="True"> and <SCE …>, each with
<Reflectances MinWavelength="400" MaxWavelength="700" WavelengthStep="10">f;f;…</Reflectances>
(fractions 0–1). DOCTYPE / ENTITY declarations are refused.

Prints one JSON result object on stdout. Standard library only.
"""
import argparse
import copy
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path("data/reflectance")
RAW = DATA / "raw" / "phone-samples.json"
INDEX = DATA / "index.json"
MANIFEST = DATA / "source-manifest.json"
OVERRIDES = Path("data/catalog-overrides.json")
SOURCE_ID = "instrument-xml-phone-samples"
MAPPING_KEYS = ["recordTag", "recordId", "expectedName", "phoneId", "phoneName", "conditionId", "conditionLabel", "panel"]
INSTRUMENT_KEYS = ("Instrument", "OpticalStruct", "MeasurementCaliber", "UV", "LensPosition")
GRID = (400, 700, 10)
EXCLUDED_DEVICES = [{"id": "ipad-pro-11-m4", "reason": "tablet; phone-only display"}]
PNG_FIELDS = {"sourcePlotBounds", "corroboration", "reflectanceRangePercent", "sourceManifest",
              "legendLabelPercent", "corroboratingPngSourceId", "digitization"}


class ImportError_(Exception):
    pass


def fail(message):
    raise ImportError_(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def dumps(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


# ---- XML -------------------------------------------------------------------------------------

def parse_xml(content):
    if b"<!DOCTYPE" in content or b"<!ENTITY" in content:
        fail("XML 带 DOCTYPE / ENTITY 声明，拒绝解析")
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        fail(f"XML 无法解析：{exc}")
    if root.tag != "ThreeNHJob":
        fail(f"根元素应为 ThreeNHJob，实际是 {root.tag}")
    return root


def extract_sample(root, mapping):
    where = f"样品 {mapping['recordTag']} ID={mapping['recordId']}（{mapping['expectedName']}）"
    matches = [e for e in root.iter(mapping["recordTag"]) if e.get("ID") == mapping["recordId"]]
    if len(matches) != 1:
        fail(f"{where}: XML 里找到 {len(matches)} 个，应恰好 1 个")
    element = matches[0]
    if element.get("Name") != mapping["expectedName"]:
        fail(f"{where}: XML 里的名称是「{element.get('Name')}」，与白名单不符（样品身份变了？）")
    if element.get("IsTransmission") != "False":
        fail(f"{where}: 不是反射测量（IsTransmission={element.get('IsTransmission')}）")
    spectra = {}
    for method in ("SCI", "SCE"):
        node = element.find(method)
        if node is None or node.get("IsReflectance") != "True":
            fail(f"{where}: 缺少 {method} 反射光谱（IsReflectance=True）")
        values = node.find("Reflectances")
        if values is None or values.text is None:
            fail(f"{where}: {method} 没有 Reflectances 读数")
        try:
            start, end, step = (int(values.get(k)) for k in ("MinWavelength", "MaxWavelength", "WavelengthStep"))
            fractions = [float(v) for v in values.text.strip().split(";")]
        except (TypeError, ValueError):
            fail(f"{where}: {method} 的波长或读数无法解析")
        if (start, end, step) != GRID:
            fail(f"{where}: {method} 波长 {start}–{end} nm / {step} nm；数据库目前只收 {GRID[0]}–{GRID[1]} nm / {GRID[2]} nm")
        if len(fractions) != (end - start) // step + 1 or any(not 0 <= v <= 1 for v in fractions):
            fail(f"{where}: {method} 读数个数不对或超出 0–1（应为反射比）")
        spectra[method] = {"rangeNm": [start, end], "sampleStepNm": step, "reflectanceFractions": fractions}
    return {**mapping, "sourceName": element.get("Name"), "measuredAt": element.get("DateTime"),
            "instrument": {k: element.get(k) for k in INSTRUMENT_KEYS}, "spectra": spectra}


def mapping_of(sample):
    return {k: sample[k] for k in MAPPING_KEYS if k in sample}


def validate_additions(additions, existing, root):
    overrides = read_json(root / OVERRIDES)
    names = {d["id"]: d["name"]["zh"] for d in overrides.get("devices", [])}
    conditions = overrides.get("reflectanceConditions", {})
    existing_by_record = {(m["recordTag"], m["recordId"]): m for m in existing}
    seen_records = set(existing_by_record)
    seen_conditions = {(m["phoneId"], m["conditionId"]) for m in existing}
    out = []
    for i, add in enumerate(additions):
        where = f"options.add[{i}]"
        if not isinstance(add, dict) or set(add) - set(MAPPING_KEYS):
            fail(f"{where}: 只能有这些字段：{'、'.join(MAPPING_KEYS)}")
        add = dict(add)
        if add.get("phoneId") not in names:
            fail(f"{where}: 机型 {add.get('phoneId')} 不在 data/catalog-overrides.json 中：先在 devices 里加上它")
        add.setdefault("phoneName", names[add["phoneId"]])
        for key in MAPPING_KEYS[:-1]:
            if not isinstance(add.get(key), str) or not add[key].strip():
                fail(f"{where}.{key} 必须是非空字符串")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", add["recordTag"]):
            fail(f"{where}.recordTag「{add['recordTag']}」不是合法的 XML 元素名")
        if add["phoneId"] in {d["id"] for d in EXCLUDED_DEVICES}:
            fail(f"{where}: {add['phoneId']} 不是手机，不进反射率索引")
        base = re.sub(r"-\d{8}$", "", add["conditionId"])
        if base not in conditions:
            fail(f"{where}: 条件「{add['conditionId']}」不在 catalog-overrides.json 的 reflectanceConditions 中（可用：{'、'.join(conditions)}，可加 -YYYYMMDD 后缀区分日期）")
        normalized = {k: add[k] for k in MAPPING_KEYS if k in add}
        already = existing_by_record.get((add["recordTag"], add["recordId"]))
        if already is not None:
            if already != normalized:
                fail(f"{where}: 样品 {add['recordId']} 已在白名单里，但写法不同（已有 {json.dumps(already, ensure_ascii=False)}）")
            continue  # approved earlier (re-running the same batch)
        if (add["recordTag"], add["recordId"]) in seen_records:
            fail(f"{where}: 样品 {add['recordId']} 重复")
        if (add["phoneId"], add["conditionId"]) in seen_conditions:
            fail(f"{where}: {add['phoneId']} 已有条件 {add['conditionId']}；同一机型的另一个样品请用不同的条件 id（例如加日期后缀）")
        seen_records.add((add["recordTag"], add["recordId"]))
        seen_conditions.add((add["phoneId"], add["conditionId"]))
        out.append(normalized)
    return out


def extract_raw(content, source_filename, mappings):
    root = parse_xml(content)
    return {"schemaVersion": 1, "sourceKind": "instrument-xml", "sourceFilename": source_filename,
            "sourceSha256": sha256(content), "sourceBytes": len(content),
            "format": {"root": root.tag, "version": root.get("Version")},
            "units": {"wavelength": "nm", "reflectance": "fraction"},
            "percentConversionFactor": 100,
            "samples": [extract_sample(root, m) for m in mappings]}


# ---- index -----------------------------------------------------------------------------------

def make_curve(sample, method, kind, raw, previous):
    spectrum = sample["spectra"][method]
    start, end = spectrum["rangeNm"]
    step = spectrum["sampleStepNm"]
    samples = [[start + i * step, value * 100] for i, value in enumerate(spectrum["reflectanceFractions"])]
    curve = {"kind": kind, "label": "全反射" if kind == "total" else "漫反射",
             "method": method, "methodNote": "ThreeNH XML IsReflectance=True",
             "rangeNm": [start, end], "coverageSpansNm": [[start, end]], "samples": samples,
             "digitized": False, "sourceKind": "instrument-xml", "sampleStepNm": step,
             "maxSampleGapNm": step, "allowsLongGap": False,
             "rawSampleId": sample["recordId"], "sourceName": sample["sourceName"],
             "measuredAt": sample["measuredAt"], "instrument": sample["instrument"],
             "sourceId": SOURCE_ID, "sourceFile": "raw/phone-samples.json",
             "sourceRelativePath": raw["sourceFilename"], "sourceSha256": raw["sourceSha256"],
             "sourceValueUnit": "fraction", "percentConversionFactor": 100}
    # PNG corroboration of the same instrument sample is kept (it is evidence, not data)
    if previous and previous.get("rawSampleId") == sample["recordId"] and previous.get("legendLabelPercent") is not None:
        curve["legendLabelPercent"] = previous["legendLabelPercent"]
        curve["corroboratingPngSourceId"] = previous.get("corroboratingPngSourceId")
    return curve


def build_index(raw, previous=None):
    """index.json from the raw readings; `previous` (an existing index) keeps order and PNG evidence."""
    if previous is None:
        result = {"schemaVersion": 2, "units": {"wavelength": "nm", "reflectance": "%"},
                  "wavelengthRangeNm": None, "phoneCount": 0, "phones": []}
    else:
        result = copy.deepcopy(previous)
        result.pop("digitization", None)
    phones = {p["id"]: p for p in result["phones"]}
    backed = set()
    for sample in raw["samples"]:
        pid = sample["phoneId"]
        if pid in {d["id"] for d in EXCLUDED_DEVICES}:
            fail(f"原始读数里有非手机样品 {pid}")
        phone = phones.get(pid)
        if phone is None:
            phone = phones[pid] = {"id": pid, "name": sample["phoneName"], "deviceType": "phone",
                                   "availability": "complete", "conditions": []}
        if sample.get("panel"):
            phone["panel"] = sample["panel"]
        condition = next((c for c in phone["conditions"] if c["id"] == sample["conditionId"]), None)
        if condition is None:
            condition = {"id": sample["conditionId"], "curves": {}}
            phone["conditions"].append(condition)
        backed.add((pid, sample["conditionId"]))
        prior = condition.get("curves", {})
        condition.update(label=sample["conditionLabel"], sourceIds=[SOURCE_ID], rawSampleId=sample["recordId"],
                         sourceName=sample["sourceName"], measuredAt=sample["measuredAt"])
        curves = condition.setdefault("curves", {})
        for method, kind in (("SCI", "total"), ("SCE", "diffuse")):
            curves[kind] = make_curve(sample, method, kind, raw, prior.get(kind))
        phone["deviceType"] = "phone"
        phone["availability"] = "complete"
    for phone in phones.values():
        for c in phone["conditions"]:
            if (phone["id"], c["id"]) not in backed:
                fail(f"index.json 的 {phone['id']} / {c['id']} 在 raw/phone-samples.json 里没有对应样品")
        if not phone["conditions"]:
            fail(f"index.json 的 {phone['id']} 没有任何样品")
        phone["conditions"].sort(key=lambda c: (c["id"] != "as-measured", c["id"]))
    spectra = [v for s in raw["samples"] for v in s["spectra"].values()]
    result.update(
        schemaVersion=2,
        wavelengthRangeNm=[min(v["rangeNm"][0] for v in spectra), max(v["rangeNm"][1] for v in spectra)],
        phoneCount=len(phones), phones=list(phones.values()),
        sourceKinds=sorted({c["sourceKind"] for p in phones.values() for q in p["conditions"] for c in q["curves"].values()}),
        sampling={"sourceKind": "instrument-xml",
                  "method": "Original ThreeNH XML Reflectances points; fraction multiplied by 100",
                  "gridIsInstrumentSampling": True,
                  "sampleStepsNm": sorted({v["sampleStepNm"] for v in spectra}),
                  "methods": ["SCI", "SCE"], "interpolatedPointsAdded": False},
        rawSource="raw/phone-samples.json", rawSourceSha256=raw["sourceSha256"],
        excludedDevices=result.get("excludedDevices", EXCLUDED_DEVICES))
    return result


def diff_paths(a, b, where="$"):
    """JSON paths where a and b differ; phones / conditions are matched by id, not position."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f"{where}.{k}")
            else:
                out += diff_paths(a[k], b[k], f"{where}.{k}")
        return out
    if isinstance(a, list) and isinstance(b, list) and a and b and all(isinstance(x, dict) and "id" in x for x in a + b):
        ai, bi = {x["id"]: x for x in a}, {x["id"]: x for x in b}
        out = [f"{where}[{i}]" for i in sorted(set(ai) ^ set(bi))]
        for i in sorted(set(ai) & set(bi)):
            out += diff_paths(ai[i], bi[i], f"{where}[{i}]")
        return out
    return [] if a == b else [where]


def png_only(path):
    return path.rsplit(".", 1)[-1] in PNG_FIELDS


# ---- commands ----------------------------------------------------------------------------------

def write_if_changed(path, data, dry_run):
    old = path.read_bytes() if path.exists() else None
    if old == data:
        return False
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return True


def cmd_import(args):
    root = Path(args.root).resolve()
    options = read_json(args.options) if args.options else {}
    if set(options) - {"add", "note"}:
        fail(f"options 有未知字段：{sorted(set(options) - {'add', 'note'})}")
    raw_path, index_path, manifest_path = root / RAW, root / INDEX, root / MANIFEST
    old_raw_bytes = raw_path.read_bytes()
    old_raw = json.loads(old_raw_bytes)
    existing = [mapping_of(s) for s in old_raw["samples"]]
    additions = validate_additions(options.get("add") or [], existing, root)
    content = Path(args.xml).read_bytes()
    source_filename = Path(args.source_name).name if args.source_name else Path(args.xml).name
    new_raw = extract_raw(content, source_filename, existing + additions)
    changed_samples = []
    for old, new in zip(old_raw["samples"], new_raw["samples"]):
        if old != new:
            diff = [k for k in sorted(set(old) | set(new)) if old.get(k) != new.get(k)]
            changed_samples.append(f"{old['recordId']}（{old['expectedName']}）：{'、'.join(diff)}")
    if changed_samples:
        fail(f"XML 里已核准样品的内容变了，不覆盖原始读数：{'；'.join(changed_samples)}")
    # same XML and nothing added: keep the raw file exactly as it is
    if not additions and new_raw["sourceSha256"] == old_raw["sourceSha256"]:
        new_raw = old_raw
    raw_bytes = old_raw_bytes if new_raw is old_raw else dumps(new_raw)
    files = {}
    files[RAW.as_posix()] = write_if_changed(raw_path, raw_bytes, args.dry_run)

    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    raw_source = {"id": SOURCE_ID, "sourceKind": "instrument-xml", "exportFile": "raw/phone-samples.json",
                  "exportSha256": sha256(raw_bytes), "sourceFilename": new_raw["sourceFilename"],
                  "sourceSha256": new_raw["sourceSha256"], "sourceBytes": new_raw["sourceBytes"],
                  "sampleCount": len(new_raw["samples"]), "phoneCount": len({s["phoneId"] for s in new_raw["samples"]})}
    if manifest.get("rawSource") != raw_source:
        manifest["rawSource"] = raw_source
        manifest_bytes = dumps(manifest)
    files[MANIFEST.as_posix()] = write_if_changed(manifest_path, manifest_bytes, args.dry_run)

    old_index_bytes = index_path.read_bytes()
    old_index = json.loads(old_index_bytes)
    new_index = build_index(new_raw, old_index)
    index_bytes = old_index_bytes if new_index == old_index else dumps(new_index)
    files[INDEX.as_posix()] = write_if_changed(index_path, index_bytes, args.dry_run)

    added = [{"recordId": s["recordId"], "expectedName": s["expectedName"], "phoneId": s["phoneId"],
              "conditionId": s["conditionId"], "measuredAt": s["measuredAt"]} for s in new_raw["samples"][len(existing):]]
    changelog = [f"反射率：新增 {s['phoneName']} · {s['conditionLabel']}（XML 样品 {s['recordId']}「{s['sourceName']}」，测量时间 {s['measuredAt']}）"
                 for s in new_raw["samples"][len(existing):]]
    if new_raw["sourceSha256"] != old_raw["sourceSha256"]:
        changelog.append(f"反射率：源 XML 更新为 sha256 {new_raw['sourceSha256'][:12]}…（原 {old_raw['sourceSha256'][:12]}…）；已核准的 {len(existing)} 个样品读数逐点不变")
    audit = {
        "importer": "pipeline/import/reflectance_xml.py",
        "source": {"file": args.source_name or Path(args.xml).name, "sha256": new_raw["sourceSha256"],
                   "bytes": new_raw["sourceBytes"], "format": new_raw["format"]},
        "previousSourceSha256": old_raw["sourceSha256"],
        "existingSamplesVerified": len(existing),
        "added": added,
        "files": {k: {"changed": v} for k, v in files.items()},
        "whitelist": "Only samples listed by recordId and expectedName are read; other XML records are ignored.",
    }
    if args.audit and not args.dry_run:
        Path(args.audit).parent.mkdir(parents=True, exist_ok=True)
        Path(args.audit).write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  已核对 {len(existing)} 个已核准样品，新增 {len(added)} 个", file=sys.stderr)
    for line in changelog:
        print(f"  {line}", file=sys.stderr)
    return {"importer": "reflectance_xml", "ok": True, "dryRun": bool(args.dry_run),
            "input": audit["source"], "changedFiles": [k for k, v in files.items() if v],
            "requiresStandaloneRebuild": False, "changelog": changelog, "warnings": [], "audit": audit}


def cmd_index(args):
    root = Path(args.root).resolve()
    raw = read_json(root / RAW)
    index_path = root / INDEX
    old_bytes = index_path.read_bytes()
    old = json.loads(old_bytes)
    new = build_index(raw, None if args.pure else old)
    result = {"importer": "reflectance_xml index", "ok": True, "pure": bool(args.pure)}
    if args.compare:
        other = read_json(args.compare)
        paths = diff_paths(other, new)
        result["differences"] = {"pngRelated": [p for p in paths if png_only(p)],
                                 "other": [p for p in paths if not png_only(p)]}
        result["phoneOrderSame"] = [p["id"] for p in other["phones"]] == [p["id"] for p in new["phones"]]
        result["ok"] = not result["differences"]["other"]
        print(f"  与 {args.compare} 比较：PNG 相关字段差异 {len(result['differences']['pngRelated'])} 处，其他差异 {len(result['differences']['other'])} 处", file=sys.stderr)
        for p in result["differences"]["other"][:20]:
            print(f"    ✗ {p}", file=sys.stderr)
        return result
    data = old_bytes if new == old else dumps(new)
    result["changedFiles"] = [INDEX.as_posix()] if write_if_changed(index_path, data, args.dry_run) else []
    return result


def cmd_verify(args):
    """Independent of extract/build: XML fraction × 100 == every published point."""
    root = Path(args.root).resolve()
    xml = parse_xml(Path(args.xml).read_bytes())
    raw = read_json(root / RAW)
    index = read_json(root / INDEX)
    points = 0
    for sample in raw["samples"]:
        original = [e for e in xml.iter(sample["recordTag"]) if e.get("ID") == sample["recordId"]]
        if len(original) != 1 or original[0].get("Name") != sample["expectedName"]:
            fail(f"XML 里找不到唯一的样品 {sample['recordId']}「{sample['expectedName']}」")
        phone = next(p for p in index["phones"] if p["id"] == sample["phoneId"])
        condition = next(c for c in phone["conditions"] if c["id"] == sample["conditionId"])
        for method, kind in (("SCI", "total"), ("SCE", "diffuse")):
            node = original[0].find(method + "/Reflectances")
            start, step = int(node.get("MinWavelength")), int(node.get("WavelengthStep"))
            fractions = [float(v) for v in node.text.strip().split(";")]
            curve = condition["curves"][kind]["samples"]
            if len(curve) != len(fractions):
                fail(f"{sample['phoneId']} / {sample['conditionId']} {method}: 点数不同")
            for i, (wave, value) in enumerate(curve):
                if wave != start + i * step or value != fractions[i] * 100:
                    fail(f"{sample['phoneId']} / {sample['conditionId']} {method} {wave} nm: 发布值 {value} ≠ XML {fractions[i]} × 100")
                points += 1
    print(f"  XML → 发布的 index.json：{points} 个原始点逐点一致（{len(raw['samples'])} 个样品）", file=sys.stderr)
    return {"importer": "reflectance_xml verify", "ok": True, "points": points, "samples": len(raw["samples"])}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("import")
    p.add_argument("--xml", required=True)
    p.add_argument("--options")
    p.add_argument("--source-name")
    p.add_argument("--batch")
    p.add_argument("--audit")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--root", default=str(ROOT))
    p = sub.add_parser("index")
    p.add_argument("--pure", action="store_true")
    p.add_argument("--compare")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--root", default=str(ROOT))
    p = sub.add_parser("verify")
    p.add_argument("--xml", required=True)
    p.add_argument("--root", default=str(ROOT))
    args = parser.parse_args(argv)
    try:
        result = {"import": cmd_import, "index": cmd_index, "verify": cmd_verify}[args.command](args)
    except ImportError_ as exc:
        print(f"反射率导入失败：{exc}", file=sys.stderr)
        print(json.dumps({"importer": "reflectance_xml", "ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
