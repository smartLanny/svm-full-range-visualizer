#!/usr/bin/env python3
"""Import SVM (flicker) blocks from a Feishu sheet CSV export into public/datasets.

Generalises scripts/import-duo-svm.py and scripts/import-mate90-svm.py: one CSV export (one sheet)
holds one or more 27-row blocks (title row, brightness row, header row, 24 gray rows). A spec file
says which block becomes which record; every non-blank cell of the sheet must belong to a declared
block, so nothing is silently dropped.

    python3 -I pipeline/import/svm_feishu_csv.py --csv <export.csv> --spec <spec.json>
        [--root <repo>] [--audit <audit.json>] [--source-copy <file>] [--source-name <rel path>]
        [--dry-run]

Rules (same as the two importers it replaces):
  * values are copied as they are: no cleaning, interpolation, clipping or luminance correction;
  * a matrix cell is null only when BOTH its nits and SVM cells are blank; one blank is an error;
  * numeric zero stays zero; integers stay integers;
  * after writing, every source cell is compared again with the saved JSON (Decimal equality).

Records are written as compact JSON (exactly like the Duo importer); manifest entries are appended
(append-only: existing devices keep their colors). An existing record or manifest entry that would
change is an error unless the block says "replace": true.

IMPORTANT: public/datasets is an input of the workbench's offline release fingerprint
(scripts/build-inputs.mjs). Whenever this importer changes a file there, release/SVM-Visualizer.html
becomes stale and `npm run build:standalone` must be run (npm test fails until then). The result
JSON says so in "requiresStandaloneRebuild".

Prints one JSON result object on stdout; human-readable notes go to stderr. Standard library only.
"""
import argparse
import csv
import hashlib
import io
import json
import math
import re
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STANDARD_BRIGHTNESS = [100, 90, 80, 70, 60, 50, 40, 30, 27, 25, 22, 20, 16, 13, 10, 6, 4, 0]
STANDARD_GRAYS = [255, 233, 212, 192, 174, 156, 139, 124, 109, 96, 83, 71, 60, 51, 42, 34, 27, 21, 15, 11, 7, 5, 2, 1]
BRIGHTNESS_LABEL = "亮度条百分比"
GRAY_LABEL = "灰阶 (Gray)"
NITS_HEADER_MARKERS = ("亮度", "Mean Raw")
SVM_HEADER_MARKER = "SVM"
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$")
BLOCK_KEYS = {"startRow", "title", "file", "id", "name", "device", "deviceEn", "mode", "modeEn",
              "recordStyle", "replace", "skip", "reason", "modeBasis", "note"}
SPEC_KEYS = {"sheet", "expectedSha256", "axes", "refreshRateHz", "blocks", "note"}
REBUILD_NOTICE = ("注意：public/datasets 已改变。它是工作台离线版 release/SVM-Visualizer.html 的指纹输入，"
                  "必须运行 npm run build:standalone 并提交重建后的文件，否则 npm test（releaseFreshness）会失败。")


class ImportError_(Exception):
    pass


def fail(message):
    raise ImportError_(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def col_name(index):
    """0 → A, 25 → Z, 26 → AA (spreadsheet column letters)."""
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def cell(row, col):
    return f"{col_name(col)}{row}"


def number(text, where):
    text = text.strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        fail(f"{where}: 应为数字或空白，实际是「{text}」")
    if not math.isfinite(value):
        fail(f"{where}: 应为有限数值，实际是「{text}」")
    return int(value) if value.is_integer() else value


def load_spec(path):
    spec = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(spec, dict):
        fail("spec 必须是 JSON 对象")
    unknown = set(spec) - SPEC_KEYS
    if unknown:
        fail(f"spec 有未知字段：{sorted(unknown)}")
    blocks = spec.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        fail("spec.blocks 必须是非空数组")
    axes = spec.get("axes") or {}
    brightness = axes.get("brightnessPercent", STANDARD_BRIGHTNESS)
    grays = axes.get("grays", STANDARD_GRAYS)
    if not brightness or not grays or len(set(brightness)) != len(brightness) or len(set(grays)) != len(grays):
        fail("spec.axes 的亮度或灰阶轴为空或有重复")
    starts, files = set(), set()
    for i, block in enumerate(blocks):
        where = f"spec.blocks[{i}]"
        if not isinstance(block, dict):
            fail(f"{where} 不是对象")
        unknown = set(block) - BLOCK_KEYS
        if unknown:
            fail(f"{where} 有未知字段：{sorted(unknown)}")
        if not isinstance(block.get("startRow"), int) or block["startRow"] < 1:
            fail(f"{where}.startRow 必须是从 1 开始的行号")
        if block["startRow"] in starts:
            fail(f"{where}: 起始行 {block['startRow']} 重复")
        starts.add(block["startRow"])
        if not isinstance(block.get("title"), str) or not block["title"].strip():
            fail(f"{where}.title 必须写出该块标题（源表 A{block['startRow']} 的原文）")
        if "skip" in block:
            if block["skip"] != "empty" or not isinstance(block.get("reason"), str) or not block["reason"].strip():
                fail(f'{where}: 跳过的块只能是 "skip": "empty"，并且要写 reason')
            continue
        for key in ("file", "device", "mode"):
            if not isinstance(block.get(key), str) or not block[key].strip():
                fail(f"{where}.{key} 必须是非空字符串")
        if not FILE_RE.match(block["file"]) or block["file"] == "manifest.json":
            fail(f"{where}.file「{block['file']}」不是合法的记录文件名")
        if block["file"] in files:
            fail(f"{where}: 记录文件 {block['file']} 重复")
        files.add(block["file"])
        if block.get("recordStyle", "full") not in ("full", "name-only"):
            fail(f'{where}.recordStyle 只能是 "full" 或 "name-only"')
    ordered = sorted(blocks, key=lambda b: b["startRow"])
    for a, b in zip(ordered, ordered[1:]):
        if b["startRow"] < a["startRow"] + 3 + len(grays):
            fail(f"块 {a['startRow']} 与块 {b['startRow']} 重叠（每块 {3 + len(grays)} 行）")
    return spec, list(brightness), list(grays)


def read_csv(raw, width):
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        fail(f"CSV 不是 UTF-8 编码：{exc}")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    out = []
    for r, row in enumerate(rows, start=1):
        for c in range(width, len(row)):
            if row[c].strip():
                fail(f"{cell(r, c)} 超出 {width} 列的测量区域，却有内容「{row[c].strip()}」")
        out.append((row + [""] * width)[:width])
    return out


def parse_block(rows, block, brightness, grays, width):
    start = block["startRow"]
    end = start + 2 + len(grays)
    if len(rows) < end:
        fail(f"块 {start}: CSV 只有 {len(rows)} 行，至少需要 {end} 行")
    row = lambda n: rows[n - 1]
    title = row(start)[0].strip()
    if title != block["title"].strip():
        fail(f"A{start}: 块标题应为「{block['title']}」，实际是「{title}」")
    for c in range(1, width):
        if row(start)[c].strip():
            fail(f"{cell(start, c)}: 标题行除 A 列外应为空，实际是「{row(start)[c].strip()}」")
    if row(start + 1)[0].strip() != BRIGHTNESS_LABEL:
        fail(f"A{start + 1}: 应为「{BRIGHTNESS_LABEL}」")
    for i, pct in enumerate(brightness):
        col = 1 + 2 * i
        found = number(row(start + 1)[col], cell(start + 1, col))
        if found != pct or row(start + 1)[col + 1].strip():
            fail(f"{cell(start + 1, col)}: 亮度列应为 {pct}（右侧单元格为空），实际是「{row(start + 1)[col]}」「{row(start + 1)[col + 1]}」")
    if row(start + 2)[0].strip() != GRAY_LABEL:
        fail(f"A{start + 2}: 应为「{GRAY_LABEL}」")
    for i in range(len(brightness)):
        col = 1 + 2 * i
        nits_header, svm_header = row(start + 2)[col], row(start + 2)[col + 1]
        if not any(m in nits_header for m in NITS_HEADER_MARKERS) or SVM_HEADER_MARKER not in svm_header:
            fail(f"{cell(start + 2, col)}:{cell(start + 2, col + 1)}: 表头应为亮度 / SVM，实际是「{nits_header}」「{svm_header}」")
    grid, blanks = [], []
    measured = zero_nits = at_or_below_500 = 0
    for r, gray in enumerate(grays):
        n = start + 3 + r
        found = number(row(n)[0], f"A{n}")
        if found != gray:
            fail(f"A{n}: 灰阶应为 {gray}，实际是「{row(n)[0]}」")
        points = []
        for c, pct in enumerate(brightness):
            col = 1 + 2 * c
            nits = number(row(n)[col], cell(n, col))
            svm = number(row(n)[col + 1], cell(n, col + 1))
            if (nits is None) != (svm is None):
                fail(f"{cell(n, col)}:{cell(n, col + 1)}: 亮度与 SVM 只有一个是空白（G{gray} / {pct} %）")
            if nits is None:
                points.append(None)
                blanks.append(f"{cell(n, col)}:{cell(n, col + 1)}")
                continue
            measured += 1
            zero_nits += nits == 0
            at_or_below_500 += nits <= 500
            points.append({"gray": gray, "brightnessPercent": pct, "nits": nits, "svm": svm})
        grid.append(points)
    return {
        "grid": grid,
        "headerNits": [p["nits"] if p else None for p in grid[0]],
        "measured": measured,
        "blanks": blanks,
        "zeroNits": zero_nits,
        "atOrBelow500": at_or_below_500,
        "range": f"A{start}:{col_name(width - 1)}{end}",
        "measurementRange": f"B{start + 3}:{col_name(width - 1)}{end}",
    }


def undeclared_cells(rows, blocks, grays):
    covered = set()
    for block in blocks:
        covered.update(range(block["startRow"], block["startRow"] + 3 + len(grays)))
    out = []
    for r, row in enumerate(rows, start=1):
        if r in covered:
            continue
        for c, value in enumerate(row):
            if value.strip():
                out.append(f"{cell(r, c)}「{value.strip()}」")
    return out


def record_bytes(record):
    return (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def manifest_bytes(manifest):
    return ("[\n" + ",\n".join("  " + json.dumps(e, ensure_ascii=False) for e in manifest) + "\n]\n").encode("utf-8")


def build_record(block, parsed, brightness, grays):
    name = block.get("name") or f"{block['device']} {block['mode']}"
    ident = block.get("id") or block["file"][: -len(".json")]
    data = [p for line in parsed["grid"] for p in line if p is not None]
    matrix = {"rows": grays, "cols": brightness, "headerNits": parsed["headerNits"], "grid": parsed["grid"]}
    if block.get("recordStyle", "full") == "name-only":
        return {"id": ident, "name": name, "data": data, "matrix": matrix}
    return {"id": ident, "name": name, "device": block["device"], "mode": block["mode"], "data": data, "matrix": matrix}


def manifest_entry(block):
    entry = {"file": block["file"], "device": block["device"]}
    if block.get("deviceEn"):
        entry["deviceEn"] = block["deviceEn"]
    entry["mode"] = block["mode"]
    if block.get("modeEn"):
        entry["modeEn"] = block["modeEn"]
    return entry


def verify_saved(saved, rows, block, brightness, grays):
    """Every source cell against the saved record (Decimal equality), like the Duo importer."""
    start = block["startRow"]
    compared = 0
    for r, gray in enumerate(grays):
        n = start + 3 + r
        for c, pct in enumerate(brightness):
            point = saved["matrix"]["grid"][r][c]
            for offset, key in ((1, "nits"), (2, "svm")):
                source = rows[n - 1][offset + 2 * c].strip()
                if not source:
                    if point is not None:
                        fail(f"{cell(n, offset + 2 * c)}: 源单元格为空，保存的记录却有值")
                    continue
                if point is None or point["gray"] != gray or point["brightnessPercent"] != pct:
                    fail(f"{cell(n, offset + 2 * c)}: 保存的记录位置不对")
                if Decimal(str(point[key])) != Decimal(source):
                    fail(f"{cell(n, offset + 2 * c)}: 源值 {source} 在保存后变成了 {point[key]}")
                compared += 1
    if saved["data"] != [p for line in saved["matrix"]["grid"] for p in line if p is not None]:
        fail(f"块 {start}: data 与 matrix.grid 不一致")
    return compared


def run(args):
    root = Path(args.root).resolve()
    csv_path = Path(args.csv)
    raw = csv_path.read_bytes()
    digest = sha256(raw)
    spec, brightness, grays = load_spec(args.spec)
    if spec.get("expectedSha256") and spec["expectedSha256"] != digest:
        fail(f"CSV 的 sha256 是 {digest}，spec 要求 {spec['expectedSha256']}")
    width = 1 + 2 * len(brightness)
    rows = read_csv(raw, width)
    blocks = sorted(spec["blocks"], key=lambda b: b["startRow"])
    stray = undeclared_cells(rows, blocks, grays)
    if stray:
        fail(f"CSV 里有 {len(stray)} 个非空单元格不属于任何声明的块（在 spec.blocks 里声明，或确认导出范围）：{'、'.join(stray[:10])}")

    datasets = root / "public" / "datasets"
    manifest_path = datasets / "manifest.json"
    manifest_raw = manifest_path.read_bytes() if manifest_path.exists() else None
    manifest = json.loads(manifest_raw) if manifest_raw is not None else []
    if not isinstance(manifest, list):
        fail("public/datasets/manifest.json 不是数组")
    by_file = {e.get("file"): e for e in manifest}

    planned, omitted = [], []
    new_manifest = list(manifest)
    for block in blocks:
        parsed = parse_block(rows, block, brightness, grays, width)
        if "skip" in block:
            if parsed["measured"]:
                fail(f"块 A{block['startRow']}「{block['title']}」声明为空模板，却有 {parsed['measured']} 个实测格")
            omitted.append({"title": block["title"], "range": parsed["range"], "measuredCells": 0,
                            "blankPairsCompared": len(parsed["blanks"]), "reason": block["reason"]})
            continue
        if parsed["measured"] == 0:
            fail(f"块 A{block['startRow']}「{block['title']}」没有任何实测格；若是空模板请写 \"skip\": \"empty\"")
        record = build_record(block, parsed, brightness, grays)
        data = record_bytes(record)
        target = datasets / block["file"]
        status = "created"
        previous_sha = None
        if target.exists():
            old = target.read_bytes()
            previous_sha = sha256(old)
            if old == data:
                status = "unchanged"
            elif block.get("replace") is True:
                status = "replaced"
            else:
                fail(f"public/datasets/{block['file']} 已存在且内容不同；原始数据不覆盖。确需替换请在该块写 \"replace\": true")
        entry = manifest_entry(block)
        if block["file"] in by_file:
            if by_file[block["file"]] != entry:
                fail(f"manifest 里已有 {block['file']}，但条目不同：现有 {json.dumps(by_file[block['file']], ensure_ascii=False)}，"
                     f"新 {json.dumps(entry, ensure_ascii=False)}。manifest 只追加，不改已有条目")
        else:
            new_manifest.append(entry)
            by_file[block["file"]] = entry
        planned.append({"block": block, "parsed": parsed, "record": record, "bytes": data, "target": target,
                        "status": status, "previousSha256": previous_sha, "entry": entry})

    new_manifest_bytes = manifest_bytes(new_manifest)
    manifest_changed = manifest_raw != new_manifest_bytes and new_manifest != manifest
    changed = [p for p in planned if p["status"] != "unchanged"]

    if not args.dry_run:
        datasets.mkdir(parents=True, exist_ok=True)
        for p in changed:
            p["target"].write_bytes(p["bytes"])
        if manifest_changed:
            manifest_path.write_bytes(new_manifest_bytes)
        if args.source_copy:
            copy = Path(args.source_copy)
            if copy.exists() and copy.read_bytes() != raw:
                fail(f"源 CSV 副本 {copy} 已存在且内容不同")
            copy.parent.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(raw)

    audits = []
    for p in planned:
        block, parsed = p["block"], p["parsed"]
        compared = None
        if not args.dry_run:
            saved = json.loads(p["target"].read_text(encoding="utf-8"))
            if saved != p["record"]:
                fail(f"{block['file']}: 读回的记录与源数据生成的不一致")
            compared = verify_saved(saved, rows, block, brightness, grays)
        points = p["record"]["data"]
        audits.append({
            "file": block["file"], "id": p["record"]["id"], "device": block["device"], "mode": block["mode"],
            "status": p["status"], "previousSha256": p["previousSha256"], "datasetSha256": sha256(p["bytes"]),
            "tableTitle": block["title"], "blockRange": parsed["range"], "measurementRange": parsed["measurementRange"],
            **({"modeBasis": block["modeBasis"]} if block.get("modeBasis") else {}),
            "matrixRows": len(grays), "matrixColumns": len(brightness),
            "matrixPairsCompared": len(grays) * len(brightness), "numericValuesCompared": compared,
            "matchedMeasurements": parsed["measured"], "matchedBlankPairs": len(parsed["blanks"]),
            "blankSourceCells": parsed["blanks"], "zeroNitsCellsPreserved": parsed["zeroNits"],
            "cellNitsAtOrBelow500": parsed["atOrBelow500"],
            "maximumRawSvm": max(pt["svm"] for pt in points), "g255HeaderNits": parsed["headerNits"],
        })

    changed_files = [f"public/datasets/{p['block']['file']}" for p in changed]
    if manifest_changed:
        changed_files.append("public/datasets/manifest.json")
    requires_rebuild = bool(changed_files)
    created = [a for a in audits if a["status"] == "created"]
    replaced = [a for a in audits if a["status"] == "replaced"]
    changelog = []
    for a in created:
        changelog.append(f"频闪：新增 {a['device']} · {a['mode']}（{a['file']}，{a['matchedMeasurements']} 个实测格、{a['matchedBlankPairs']} 个空格）")
    for a in replaced:
        changelog.append(f"频闪：替换 {a['device']} · {a['mode']}（{a['file']}，{a['matchedMeasurements']} 个实测格）")
    audit = {
        "importer": "pipeline/import/svm_feishu_csv.py",
        "source": {
            "file": args.source_name or csv_path.name, "sha256": digest, "bytes": len(raw),
            "rows": len(rows), "columns": width, **({"sheet": spec["sheet"]} if spec.get("sheet") else {}),
            **({"refreshRateHz": spec["refreshRateHz"]} if spec.get("refreshRateHz") else {}),
            **({"sourceCopy": Path(args.source_copy).resolve().relative_to(root).as_posix()} if args.source_copy and Path(args.source_copy).resolve().is_relative_to(root) else {}),
        },
        "records": audits,
        "omittedBlocks": omitted,
        "manifest": {"before": len(manifest), "after": len(new_manifest),
                     "appended": [e["file"] for e in new_manifest[len(manifest):]]},
        "handling": "No cleaning, interpolation, clipping, or luminance correction at import. A cell is null only when both nits and SVM are blank; numeric zero is kept.",
        "requiresStandaloneRebuild": requires_rebuild,
    }
    if args.audit and not args.dry_run:
        Path(args.audit).parent.mkdir(parents=True, exist_ok=True)
        Path(args.audit).write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    result = {
        "importer": "svm_feishu_csv", "ok": True, "dryRun": bool(args.dry_run),
        "input": {"file": audit["source"]["file"], "sha256": digest, "bytes": len(raw)},
        "records": [{"file": a["file"], "status": a["status"], "measured": a["matchedMeasurements"], "blanks": a["matchedBlankPairs"]} for a in audits],
        "omittedBlocks": [o["range"] for o in omitted],
        "manifest": audit["manifest"],
        "changedFiles": changed_files,
        "requiresStandaloneRebuild": requires_rebuild,
        "changelog": changelog,
        "audit": audit,
    }
    for a in audits:
        print(f"  {a['status']:9} {a['file']}：{a['device']} · {a['mode']}，实测 {a['matchedMeasurements']} 格、空 {a['matchedBlankPairs']} 格", file=sys.stderr)
    for o in omitted:
        print(f"  跳过空模板 {o['range']}「{o['title']}」：{o['reason']}", file=sys.stderr)
    if requires_rebuild:
        print(REBUILD_NOTICE, file=sys.stderr)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", required=True, help="飞书工作表的 CSV 导出")
    parser.add_argument("--spec", required=True, help="块规格 JSON（批次文件里 inputs[].svm 的内容）")
    parser.add_argument("--root", default=str(ROOT), help="仓库根目录（测试时用临时目录）")
    parser.add_argument("--audit", help="审计 JSON 输出路径")
    parser.add_argument("--source-copy", help="把源 CSV 原样复制到这里（随批次提交）")
    parser.add_argument("--source-name", help="审计里记录的源文件名（相对 NAS_ROOT 的路径）")
    parser.add_argument("--dry-run", action="store_true", help="只报告会发生什么，不写文件")
    args = parser.parse_args(argv)
    try:
        result = run(args)
    except ImportError_ as exc:
        print(f"频闪导入失败：{exc}", file=sys.stderr)
        print(json.dumps({"importer": "svm_feishu_csv", "ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
