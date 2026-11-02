#!/usr/bin/env python3
"""Import uniformity heatmaps (a package from pipeline/uniformity/make_maps.py) into data/uniformity/.

    python3 -I pipeline/import/uniformity_maps.py --package <uniformity_maps.zip> --options <options.json>
        [--root <repo>] [--batch <batch id>] [--source-name <name>] [--audit <audit.json>] [--dry-run]

Package: a zip with manifest.json and maps/<level>_<lum|cct>_<source id>.png (portrait RGBA PNGs).
manifest.json: {"schemaVersion": 1, "colorStops": [...], "maps": {"<key>": {"sourceId", "level",
"kind", "metrics": {"typ", "u9", "ua", "dev10"} | {"typ", "d9", "da"}, "scale", "assetSha256",
"sourceSha256", "sourceResolution", "displayResolution", "sourceMaskBounds", "sourceMaskCoverage",
"measurementSource", "measurementSourceSha256", "measurementResolution"}}}.

Options (inputs[].options in a batch file):
  {"devices": {"iphone-17-pro-max": {"sourceId": "ip17pm"}, "honor-magic-v5": {"sourceId": "mv5", "display": "outer"}},
   "replace": false}

Per device listed:
  * metrics-only device (index "metricsOnly"): the heatmaps must have been made with exactly the
    stored numbers (same rounding) and the same conditions; the device moves to "phones" with its
    maps. Measured white readings already recorded are kept.
  * device without uniformity data ("notRecorded" or absent): added to "phones", numbers from the
    package.
  * device that already has heatmaps: identical → unchanged; different → error unless "replace".
Every PNG is checked against the manifest (sha256, PNG header: RGBA 8 bit, portrait size) and
written to data/uniformity/maps/; an existing file with other content is an error unless
"replace". The colour stops must equal the index's. Standard library only.
"""
import argparse
import copy
import hashlib
import json
import struct
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from uniformity_metrics import (  # noqa: E402  (shared rules: rounding, level labels)
    INDEX, KINDS, LEVELS, OVERRIDES, ImportError_, compare_block, fail, metric_block,
)

ROOT = Path(__file__).resolve().parents[2]
MAPS_DIR = Path("data/uniformity/maps")
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def png_header(data, where):
    if data[:8] != PNG_SIG or data[12:16] != b"IHDR":
        fail(f"{where}: 不是 PNG")
    width, height, depth, color = struct.unpack(">IIBB", data[16:26])
    if depth != 8 or color != 6:
        fail(f"{where}: 应是 8 位 RGBA PNG（位深 {depth}，颜色类型 {color}）")
    return [width, height]


def strip_white(conditions):
    return [{k: v for k, v in c.items() if not k.startswith("whiteMeasured")} for c in conditions]


def run(args):
    root = Path(args.root).resolve()
    options = json.loads(Path(args.options).read_text(encoding="utf-8")) if args.options else {}
    unknown = set(options) - {"devices", "replace", "note"}
    if unknown:
        fail(f"options 有未知字段：{sorted(unknown)}")
    replace = options.get("replace") is True
    devices = options.get("devices")
    if not isinstance(devices, dict) or not devices:
        fail("options.devices 应是 {机型 id: {sourceId}} 对象")

    raw = Path(args.package).read_bytes()
    source = {"file": args.source_name or Path(args.package).name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
    try:
        z = zipfile.ZipFile(args.package)
        manifest = json.loads(z.read("manifest.json").decode("utf-8"))
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"热力图包无法读取（应是含 manifest.json 的 zip）：{exc}")
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("maps"), dict):
        fail("manifest.json 格式不对（schemaVersion 1，maps 对象）")
    entries = set(z.namelist())

    index_path = root / INDEX
    index_raw = index_path.read_bytes()
    index = json.loads(index_raw)
    result = copy.deepcopy(index)
    if manifest.get("colorStops") != index.get("colorStops"):
        fail("热力图包的色条（colorStops）与库里的不一致：同一套色条才能并排比较")
    names = {d["id"]: d["name"]["zh"] for d in json.loads((root / OVERRIDES).read_text(encoding="utf-8")).get("devices", [])}

    by_sid = {}
    for key, m in manifest["maps"].items():
        if not isinstance(m, dict) or f"{m.get('level')}_{m.get('kind')}_{m.get('sourceId')}" != key:
            fail(f"manifest 的 {key}: level / kind / sourceId 与键名不符")
        if m["level"] not in LEVELS or m["kind"] not in KINDS:
            fail(f"{key}: 档位或类型不认识")
        by_sid.setdefault(m["sourceId"], {})[(m["level"], m["kind"])] = (key, m)
    used = set()

    audit_devices, changelog, writes = [], [], {}
    for device_id, spec in devices.items():
        spec = spec or {}
        if device_id not in names:
            fail(f"机型 {device_id} 不在 data/catalog-overrides.json 中")
        sid = spec.get("sourceId")
        if sid not in by_sid:
            fail(f"{device_id}: 热力图包里没有 {sid!r}（包里有：{'、'.join(sorted(by_sid))}）")
        if spec.get("display") not in (None, "main", "inner", "outer"):
            fail(f"{device_id}: display 应是 main / inner / outer")
        mine = by_sid[sid]
        conditions = []
        for level, meta in LEVELS.items():
            lum, cct = mine.get((level, "lum")), mine.get((level, "cct"))
            if lum is None and cct is None:
                continue
            if lum is None:
                fail(f"{sid} / {level}: 只有色温图没有亮度图")
            cond = {"id": level, **meta, "maps": {}, "metrics": {}}
            for kind, item in (("lum", lum), ("cct", cct)):
                if item is None:
                    continue
                key, m = item
                used.add(key)
                name = f"maps/{key}.png"
                if m.get("asset") != name or name not in entries:
                    fail(f"{key}: 包里没有 {name}")
                data = z.read(name)
                if hashlib.sha256(data).hexdigest() != m.get("assetSha256"):
                    fail(f"{name}: sha256 与 manifest 不符")
                size = png_header(data, name)
                if size != m.get("displayResolution") or size[0] > size[1] or [size[1], size[0]] != m.get("sourceResolution"):
                    fail(f"{name}: 尺寸 {size} 与 manifest 不符或不是竖图")
                cond["metrics"][KINDS[kind]] = metric_block(m["metrics"], kind, key)
                info = {"asset": name, "sourceKey": key}
                for k in ("sourceSha256", "assetSha256", "sourceResolution", "displayResolution", "sourceMaskBounds",
                          "sourceMaskCoverage", "measurementResolution", "measurementSourceSha256", "measurementSource", "scale"):
                    if k not in m:
                        fail(f"{key}: manifest 缺少 {k}")
                    info[k] = m[k]
                cond["maps"][KINDS[kind]] = info
                writes[name] = data
            conditions.append(cond)

        phone = next((p for p in result.get("phones", []) if p["id"] == device_id), None)
        metrics_only = next((m for m in result.get("metricsOnly", []) if m["id"] == device_id), None)
        display = spec.get("display") or (metrics_only or {}).get("display") or (phone or {}).get("display")
        entry = {"id": device_id, "name": names[device_id], "heatmapStatus": "has-maps",
                 **({"display": display} if display and display != "main" else {}),
                 "mapsSource": {**source, **({"batch": args.batch} if args.batch else {})}, "conditions": conditions}
        status = "created"
        if phone is not None:
            if strip_white(phone["conditions"]) == conditions and phone.get("display") == entry.get("display"):
                status = "unchanged"
            elif not replace:
                fail(f"{device_id} 已有热力图且不同；确需替换请在 options 里写 \"replace\": true")
            else:
                status = "replaced"
            old = phone["conditions"]
        elif metrics_only is not None:
            old = metrics_only.get("conditions") or []
            have = {(c["id"], k) for c in old for k in c.get("metrics", {})}
            new = {(c["id"], k) for c in conditions for k in c["metrics"]}
            if old and have != new:
                fail(f"{device_id}: 热力图的档位 {sorted(new)} 与库里的指标 {sorted(have)} 不一致")
            diffs = []
            for c in old:
                for kind, name in KINDS.items():
                    if name in c.get("metrics", {}):
                        key, m = mine[(c["id"], kind)]
                        diffs += [f"{c['id']} {kind} {d}" for d in compare_block(c["metrics"][name], m["metrics"], kind)]
            if diffs and not replace:
                fail(f"{device_id}: 热力图包的指标与库里的不同（{'；'.join(diffs)}）：热力图和数字必须出自同一次计算")
            status = "promoted"
            result["metricsOnly"] = [m for m in result["metricsOnly"] if m["id"] != device_id]
        else:
            old = []
            result["notRecorded"] = [m for m in result.get("notRecorded", []) if m["id"] != device_id]
        if status != "unchanged":
            whites = {c["id"]: {k: v for k, v in c.items() if k.startswith("whiteMeasured")} for c in old}
            entry["conditions"] = [{**c, **whites.get(c["id"], {})} for c in conditions]
            if phone is not None:
                result["phones"] = [entry if p["id"] == device_id else p for p in result["phones"]]
            else:
                result.setdefault("phones", []).append(entry)
            levels = "、".join(f"{c['id']} nits" for c in conditions)
            n = sum(len(c["maps"]) for c in conditions)
            verb = {"created": "新增", "promoted": "补上", "replaced": "替换"}[status]
            changelog.append(f"均匀度：{names[device_id]} {verb}热力图 {n} 张（{levels}；源 id {sid}）")
        audit_devices.append({"device": device_id, "sourceId": sid, "status": status,
                              "maps": sorted(m["sourceKey"] for c in conditions for m in c["maps"].values())})

    extra = sorted(set(manifest["maps"]) - used)
    if extra:
        fail(f"热力图包里有没指定机型的图：{extra}（在 options.devices 里列出，或重新打包）")

    changed_files = []
    maps_dir = root / MAPS_DIR
    for name, data in sorted(writes.items()):
        target = root / "data/uniformity" / name
        if target.exists():
            if target.read_bytes() == data:
                continue
            if not replace:
                fail(f"data/uniformity/{name} 已存在且内容不同；确需替换请写 \"replace\": true")
        changed_files.append(f"data/uniformity/{name}")
        if not args.dry_run:
            maps_dir.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    changed = result != index
    new_raw = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8") if changed else index_raw
    if changed:
        changed_files.append(INDEX.as_posix())
        if not args.dry_run:
            index_path.write_bytes(new_raw)
    audit = {
        "importer": "pipeline/import/uniformity_maps.py",
        "source": source,
        "tool": manifest.get("tool"),
        "vendor": manifest.get("vendor"),
        "devices": audit_devices,
        "maps": {k: {f: m.get(f) for f in ("assetSha256", "sourceSha256", "measurementSource", "measurementSourceSha256", "measurementResolution")}
                 for k, m in sorted(manifest["maps"].items())},
        "index": {"path": INDEX.as_posix(), "sha256Before": hashlib.sha256(index_raw).hexdigest(),
                  "sha256After": hashlib.sha256(new_raw).hexdigest(), "changed": changed},
    }
    if args.audit and not args.dry_run:
        Path(args.audit).parent.mkdir(parents=True, exist_ok=True)
        Path(args.audit).write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for d in audit_devices:
        print(f"  {d['status']:10} {d['device']}（{d['sourceId']}）：{len(d['maps'])} 张", file=sys.stderr)
    return {"importer": "uniformity_maps", "ok": True, "dryRun": bool(args.dry_run), "input": source,
            "changedFiles": changed_files, "requiresStandaloneRebuild": False, "changelog": changelog, "warnings": [], "audit": audit}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", required=True, help="make_maps.py 生成的 zip")
    parser.add_argument("--options", help="选项 JSON（批次文件里 inputs[].options 的内容）")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--batch", help="批次 id，写进来源记录")
    parser.add_argument("--source-name", help="审计里记录的源文件名")
    parser.add_argument("--audit", help="审计 JSON 输出路径")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = run(args)
    except ImportError_ as exc:
        print(f"均匀度热力图导入失败：{exc}", file=sys.stderr)
        print(json.dumps({"importer": "uniformity_maps", "ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
