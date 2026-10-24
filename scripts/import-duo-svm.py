#!/usr/bin/env python3
"""Import the four Duo SVM blocks from revision-91 Feishu CLI snapshots unchanged."""
import csv
import io
import json
import math
import re
import sys
from decimal import Decimal
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BRIGHTNESS = [100, 90, 80, 70, 60, 50, 40, 30, 27, 25, 22, 20, 16, 13, 10, 6, 4, 0]
GRAYS = [255, 233, 212, 192, 174, 156, 139, 124, 109, 96, 83, 71, 60, 51, 42, 34, 27, 21, 15, 11, 7, 5, 2, 1]


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"non-finite source value: {value!r}")
    return int(result) if result.is_integer() else result


def read_snapshot(path):
    envelope = json.loads(path.read_text(encoding="utf-8"))
    assert envelope["ok"] is True
    data = envelope["data"]
    assert data["revision"] == 91 and data["current_region"] == "A1:AK54"
    columns = data["col_indices"]
    assert columns == list("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ["A" + c for c in "ABCDEFGHIJK"]
    rows = {}
    for line in data["annotated_csv"].splitlines():
        match = re.fullmatch(r"\[row=(\d+)\] ?(.*)", line)
        assert match, f"missing annotated row prefix: {line!r}"
        row = int(match[1])
        assert row not in rows, f"duplicate source row {row}"
        rows[row] = next(csv.reader([match[2]]))
        assert len(rows[row]) == len(columns), f"row {row}: expected 37 source columns"
    assert all(row in rows for row in range(1, 55))
    assert all(not any(value.strip() for value in cells) for row, cells in rows.items() if row > 54)
    return data, columns, rows


def import_screen(snapshot, screen):
    data, columns, rows = read_snapshot(snapshot)
    label = {"inner": "内屏", "outer": "外屏"}[screen]
    device = f"iPhone Duo {label}"
    fixture = ROOT / "test-fixtures" / f"iphone_duo_{screen}_revision91.csv"
    fixture.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.StringIO(newline="")
    csv.writer(buffer, lineterminator="\n").writerows(rows[row] for row in range(1, 55))
    fixture.write_text(buffer.getvalue(), encoding="utf-8")
    entries, audits = [], []
    for start, smooth in [(1, False), (28, True)]:
        title = device + (" 脉冲平滑" if smooth else "")
        assert rows[start][0] == title
        assert rows[start + 1][0] == "亮度条百分比"
        assert rows[start + 2][0] == "灰阶 (Gray)"
        for c, pct in enumerate(BRIGHTNESS):
            col = 1 + 2 * c
            assert number(rows[start + 1][col]) == pct and not rows[start + 1][col + 1].strip()
            assert "Mean Raw" in rows[start + 2][col] and "SVM" in rows[start + 2][col + 1]
        grid, blanks = [], []
        for r, gray in enumerate(GRAYS):
            row = start + 3 + r
            assert number(rows[row][0]) == gray
            points = []
            for c, pct in enumerate(BRIGHTNESS):
                col = 1 + 2 * c
                nits, svm = rows[row][col].strip(), rows[row][col + 1].strip()
                assert bool(nits) == bool(svm), f"unpaired blank: {columns[col]}{row}:{columns[col + 1]}{row}"
                if not nits:
                    points.append(None)
                    blanks.append(f"{columns[col]}{row}:{columns[col + 1]}{row}")
                else:
                    points.append({"gray": gray, "brightnessPercent": pct, "nits": number(nits), "svm": number(svm)})
            grid.append(points)
        ident = f"iPhoneDuo_{screen}{'_smooth' if smooth else ''}_120hz"
        mode = ("脉冲平滑" if smooth else "普通") + " 120Hz"
        record = {
            "id": ident, "name": f"{device} {mode}", "device": device, "mode": mode,
            "data": [point for line in grid for point in line if point is not None],
            "matrix": {"rows": GRAYS, "cols": BRIGHTNESS, "headerNits": [p["nits"] for p in grid[0]], "grid": grid},
        }
        destination = ROOT / "public/datasets" / f"{ident}.json"
        destination.write_text(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        saved = json.loads(destination.read_text(encoding="utf-8"))
        compared = 0
        for r, gray in enumerate(GRAYS):
            row = start + 3 + r
            for c, pct in enumerate(BRIGHTNESS):
                point = saved["matrix"]["grid"][r][c]
                for offset, key in [(1, "nits"), (2, "svm")]:
                    source = rows[row][offset + 2 * c].strip()
                    if not source:
                        assert point is None
                    else:
                        assert point["gray"] == gray and point["brightnessPercent"] == pct
                        assert Decimal(str(point[key])) == Decimal(source), f"changed source {columns[offset + 2 * c]}{row}"
                        compared += 1
        assert saved["data"] == [point for line in saved["matrix"]["grid"] for point in line if point is not None]
        assert saved["matrix"]["headerNits"] == [number(rows[start + 3][1 + 2 * c]) for c in range(18)]
        points = saved["data"]
        entries.append({
            "file": destination.name, "device": device,
            "deviceEn": f"iPhone Duo {'Inner' if screen == 'inner' else 'Outer'} display",
            "mode": mode, "modeEn": "Smooth pulse 120Hz" if smooth else "Standard 120Hz",
        })
        audits.append({
            "file": destination.name, "id": ident, "device": device, "mode": mode,
            "source": {
                "provider": "Feishu spreadsheet read-only CLI snapshot", "snapshot": snapshot.name,
                "revision": data["revision"], "tableTitle": title, "currentRegion": data["current_region"],
                "blockRange": f"A{start}:AK{start + 26}", "measurementRange": f"B{start + 3}:AK{start + 26}",
                "rawFixture": str(fixture.relative_to(ROOT)), "refreshRateHz": 120,
                "spreadsheetUrl": "https://gcnookhci7q8.feishu.cn/sheets/LxLdsamxKhAq5CtdRJdcK0h7n1c?sheet=" + ("rWkrKM" if screen == "inner" else "ZqTkQh"),
                "modeBasis": "Sheet titles specify 120Hz; the unmodified row-1 header is labeled ordinary mode, and row 28 explicitly states smooth pulse.",
            },
            "matrixRows": 24, "matrixColumns": 18, "matrixPairsCompared": 432,
            "numericValuesCompared": compared, "matchedMeasurements": len(points), "matchedBlankPairs": len(blanks),
            "blankSourceCells": blanks, "zeroNitsCellsPreserved": sum(p["nits"] == 0 for p in points),
            "maximumRawSvm": max(p["svm"] for p in points), "g255HeaderNits": saved["matrix"]["headerNits"],
            "comparison": "Every raw Mean Raw and SVM value matches the annotated source numerically, including zero and spikes.",
        })
    return entries, audits


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: import-duo-svm.py <inner-cli-snapshot.json> <outer-cli-snapshot.json>")
    entries, records = [], []
    for screen, source in zip(["inner", "outer"], sys.argv[1:]):
        screen_entries, screen_audits = import_screen(Path(source), screen)
        entries.extend(screen_entries)
        records.extend(screen_audits)
    manifest_path = ROOT / "public/datasets/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    existing = {entry["file"]: entry for entry in manifest}
    for entry in entries:
        if entry["file"] in existing:
            assert existing[entry["file"]] == entry
        else:
            manifest.append(entry)
    manifest_path.write_text("[\n" + ",\n".join("  " + json.dumps(e, ensure_ascii=False) for e in manifest) + "\n]\n", encoding="utf-8")
    audit = {
        "recordsImported": 4, "bundledRecordCount": len(manifest), "records": records,
        "matrixPairsCompared": sum(r["matrixPairsCompared"] for r in records),
        "numericValuesCompared": sum(r["numericValuesCompared"] for r in records),
        "matchedMeasurements": sum(r["matchedMeasurements"] for r in records),
        "matchedBlankPairs": sum(r["matchedBlankPairs"] for r in records),
        "handling": "No cleaning, interpolation, clipping, or luminance correction at import. Existing view-time denoising is unchanged.",
    }
    audit_path = ROOT / "docs/data-imports/iphone-duo-svm-revision91.json"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in audit.items() if k != "records"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
