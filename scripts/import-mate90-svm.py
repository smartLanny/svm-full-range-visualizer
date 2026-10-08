#!/usr/bin/env python3
"""Convert and audit the supplied Mate 90 SVM sheet CSV without filling blanks."""
import csv
import hashlib
import io
import json
import math
import sys
from pathlib import Path


DEVICE = "华为 Mate 90 Pro Max 典藏版"
LOW_FLICKER_TITLE = f"{DEVICE} 屏幕低频闪"
BRIGHTNESS = [100, 90, 80, 70, 60, 50, 40, 30, 27, 25, 22, 20, 16, 13, 10, 6, 4, 0]
GRAYS = [255, 233, 212, 192, 174, 156, 139, 124, 109, 96, 83, 71, 60, 51, 42, 34, 27, 21, 15, 11, 7, 5, 2, 1]
CSV_SHA256 = "2781b243035bf9280ccc3739ae92422f8b0704b69626491d6d11d9e9ef502c1f"


def number(value, where):
    value = value.strip()
    if not value:
        return None
    try:
        result = float(value)
    except ValueError as exc:
        raise ValueError(f"{where}: expected a number or a blank") from exc
    if not math.isfinite(result):
        raise ValueError(f"{where}: expected a finite number")
    return int(result) if result.is_integer() else result


def load_csv(path):
    raw = path.read_bytes()
    actual_hash = hashlib.sha256(raw).hexdigest()
    if actual_hash != CSV_SHA256:
        raise ValueError(f"CSV SHA-256 changed: {actual_hash}")
    text = raw.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    if len(rows) != 54:
        raise ValueError(f"expected 54 logical CSV rows, got {len(rows)}")
    if any(len(row) > 37 for row in rows):
        raise ValueError("CSV contains more than 37 columns")
    rows = [row + [""] * (37 - len(row)) for row in rows]
    return raw, actual_hash, rows


def parse_block(rows, start, expected_title):
    title = rows[start][0].strip()
    if title != expected_title:
        raise ValueError(f"row {start + 1}: unexpected block title {title!r}")
    brightness_header = rows[start + 1]
    if brightness_header[0].strip() != "亮度条百分比":
        raise ValueError(f"row {start + 2}: brightness header is missing")
    brightness = []
    for i, expected in enumerate(BRIGHTNESS):
        col = 1 + 2 * i
        found = number(brightness_header[col], f"row {start + 2}, column {col + 1}")
        if found != expected or brightness_header[col + 1].strip():
            raise ValueError(f"row {start + 2}: unexpected brightness pair at column {col + 1}")
        brightness.append(int(found))

    fields = rows[start + 2]
    if fields[0].strip() != "灰阶 (Gray)":
        raise ValueError(f"row {start + 3}: gray header is missing")
    for i in range(len(BRIGHTNESS)):
        nits_header = fields[1 + 2 * i].strip()
        svm_header = fields[2 + 2 * i].strip()
        if "亮度" not in nits_header or "SVM" not in svm_header:
            raise ValueError(f"row {start + 3}: unexpected measurement headers")

    grays = []
    grid = []
    measured = 0
    numeric_cells = 0
    low_gray_nits_under_500 = 0
    zero_nits = 0
    for offset, row in enumerate(rows[start + 3 : start + 27]):
        gray = number(row[0], f"row {start + 4 + offset}, column 1")
        if gray != GRAYS[offset]:
            raise ValueError(f"row {start + 4 + offset}: unexpected gray {gray!r}")
        grays.append(int(gray))
        points = []
        for i, pct in enumerate(BRIGHTNESS):
            nits = number(row[1 + 2 * i], f"gray {gray}, {pct}% nits")
            svm = number(row[2 + 2 * i], f"gray {gray}, {pct}% SVM")
            if (nits is None) != (svm is None):
                raise ValueError(f"gray {gray}, {pct}%: only one of nits/SVM is blank")
            if nits is None:
                points.append(None)
                continue
            measured += 1
            numeric_cells += 2
            zero_nits += nits == 0
            low_gray_nits_under_500 += nits <= 500
            points.append({"gray": int(gray), "brightnessPercent": pct, "nits": nits, "svm": svm})
        grid.append(points)

    header_nits = grid[0]
    header_nits = [point["nits"] if point else None for point in header_nits]
    return {
        "title": title,
        "brightness": brightness,
        "grays": grays,
        "grid": grid,
        "headerNits": header_nits,
        "measuredCells": measured,
        "missingCells": len(BRIGHTNESS) * len(GRAYS) - measured,
        "numericCells": numeric_cells,
        "zeroNitsCells": zero_nits,
        "cellNitsAtOrBelow500": low_gray_nits_under_500,
    }


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: import-mate90-svm.py <source.csv> <dataset.json> <audit.json>")
    source_path, dataset_path, audit_path = map(Path, sys.argv[1:])
    raw_bytes, digest, rows = load_csv(source_path)
    standard = parse_block(rows, 0, DEVICE)
    low_flicker = parse_block(rows, 27, LOW_FLICKER_TITLE)
    if standard["measuredCells"] != 72 or low_flicker["measuredCells"] != 0:
        raise ValueError("expected 72 standard-mode measurements and an empty low-flicker block")

    record = {
        "id": "huawei_mate90promax_20261008",
        "name": DEVICE,
        "data": [point for row in standard["grid"] for point in row if point is not None],
        "matrix": {
            "rows": standard["grays"],
            "cols": standard["brightness"],
            "headerNits": standard["headerNits"],
            "grid": standard["grid"],
        },
    }
    dataset_path.parent.mkdir(parents=True, exist_ok=True)
    dataset_path.write_text(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    roundtrip = json.loads(dataset_path.read_text(encoding="utf-8"))
    if roundtrip != record:
        raise ValueError("serialized dataset does not match the source-derived record")

    compared = {"matrixPairs": 0, "matchedMeasurements": 0, "matchedBlankPairs": 0, "numericValues": 0}
    for r, gray in enumerate(GRAYS):
        source_row = rows[3 + r]
        if number(source_row[0], f"gray row {r}") != gray:
            raise ValueError(f"source gray row {r} changed during round-trip verification")
        for c, pct in enumerate(BRIGHTNESS):
            source_nits = number(source_row[1 + 2 * c], f"gray {gray}, {pct}% nits")
            source_svm = number(source_row[2 + 2 * c], f"gray {gray}, {pct}% SVM")
            saved = roundtrip["matrix"]["grid"][r][c]
            compared["matrixPairs"] += 1
            if source_nits is None:
                if saved is not None:
                    raise ValueError(f"blank source pair became a value at gray {gray}, {pct}%")
                compared["matchedBlankPairs"] += 1
                continue
            expected = {"gray": gray, "brightnessPercent": pct, "nits": source_nits, "svm": source_svm}
            if saved != expected:
                raise ValueError(f"source pair changed at gray {gray}, {pct}%")
            compared["matchedMeasurements"] += 1
            compared["numericValues"] += 2
    for c, expected in enumerate(standard["headerNits"]):
        if roundtrip["matrix"]["headerNits"][c] != expected:
            raise ValueError(f"G255 header nits changed at {BRIGHTNESS[c]}%")
    if roundtrip["data"] != [p for row in roundtrip["matrix"]["grid"] for p in row if p is not None]:
        raise ValueError("flat data does not match the matrix cells")
    if compared != {"matrixPairs": 432, "matchedMeasurements": 72, "matchedBlankPairs": 360, "numericValues": 144}:
        raise ValueError(f"unexpected source comparison totals: {compared}")

    audit = {
        "source": {
            "provider": "Feishu spreadsheet CSV export",
            "workbookTitle": "华为 Mate 90 Pro Max 典藏版 测试图表",
            "sheetTitle": "华为 Mate 90 Pro Max 典藏版 全灰阶 SVM",
            "sheetId": "ZqTkQh",
            "exportRange": "A1:AK54",
            "standardBlockRange": "A1:AK27",
            "lowFlickerBlockRange": "A28:AK54",
            "exportRows": len(rows),
            "exportColumns": len(rows[0]),
            "exportBytes": len(raw_bytes),
            "exportSha256": digest,
        },
        "importedRecord": {
            "file": dataset_path.name,
            "device": DEVICE,
            "mode": "默认",
            "modeLabelSource": "The user confirmed this is the phone's default mode; A1 contains only the device name.",
            "matrixRange": "A4:AK27",
            "matrixRows": len(standard["grays"]),
            "matrixColumns": len(standard["brightness"]),
            "brightnessPercent": standard["brightness"],
            "grayLevels": standard["grays"],
            "measuredCells": standard["measuredCells"],
            "missingCells": standard["missingCells"],
            "numericSourceCells": standard["numericCells"],
            "zeroNitsCellsPreserved": standard["zeroNitsCells"],
            "cellNitsAtOrBelow500": standard["cellNitsAtOrBelow500"],
            "g255HeaderNits": standard["headerNits"],
            "measuredG255ColumnsAtOrBelow500": sum(n is not None and n <= 500 for n in standard["headerNits"]),
            "cellComparison": compared,
            "datasetSha256": hashlib.sha256(dataset_path.read_bytes()).hexdigest(),
        },
        "omittedBlock": {
            "title": low_flicker["title"],
            "range": "A31:AK54",
            "matrixRows": len(low_flicker["grays"]),
            "matrixColumns": len(low_flicker["brightness"]),
            "measuredCells": low_flicker["measuredCells"],
            "missingCells": low_flicker["missingCells"],
            "reason": "This is an unused template block with a residual title; the user confirmed the phone has no separate screen low-flicker mode, so no record was created.",
            "blankPairsCompared": 432,
        },
        "blankHandling": "A measurement is null only when both source cells are blank. Numeric zero remains zero. No source values are interpolated by this importer.",
    }
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"dataset": str(dataset_path), "audit": str(audit_path), "sha256": digest,
                      "measurements": standard["measuredCells"], "missing": standard["missingCells"],
                      "lowFlickerMeasurements": low_flicker["measuredCells"],
                      "cellNitsAtOrBelow500": standard["cellNitsAtOrBelow500"],
                      "g255AtOrBelow500Columns": sum(n is not None and n <= 500 for n in standard["headerNits"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
