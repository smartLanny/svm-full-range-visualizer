#!/usr/bin/env python3
"""Make a uniformity heatmap package for db:import (batch input type "uniformity-maps").

    python3 pipeline/uniformity/make_maps.py --data-root <NAS 01单机数据/> --ids ip17pm,mi15u \\
        [--extra extra.json] --out inbox/<batch id>/files/uniformity_maps.zip [--work <dir>]

It runs the video project's own scripts (pipeline/uniformity/vendor/: render.py, uni.py and
export_maps.py, copied byte for byte) on the original Radiant ProMetric matrices, so the heatmaps
and every number come from the same code as data/uniformity_metrics.json. Nothing is recomputed
differently here; this file only
  * points the scripts at --data-root and at the phones in --ids (export_maps.py has three phones
    hard-coded), and reads CSV matrix exports as well as TXT (CSV: comma separated, empty = 0);
  * --extra adds phones that render.py does not list, in its own format:
      [["m90pm", "华为 Mate 90 Pro Max 典藏版", {"300": [["", "<lum path>", "<cct path or null>"]], ...}]]
    (paths relative to --data-root; the first entry of a level is the default condition);
  * packages the result: each PNG is rotated to portrait (lossless transpose, checked pixel for
    pixel, as the atlas did), and manifest.json records the metrics, the colour scale, the PNG
    hashes and the sha256 / size of every source matrix.

Needs numpy, scipy and pillow (the video project's own dependencies). db:import itself does not:
pipeline/import/uniformity_maps.py reads the package with the standard library.
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

VENDOR = Path(__file__).resolve().parent / "vendor"
VENDOR_FILES = ("render.py", "uni.py", "export_maps.py")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def matrix_dimensions(path):
    """[columns, rows] of a measurement matrix, as the atlas recorded it."""
    raw = Path(path).read_bytes()
    if str(path).lower().endswith(".csv"):
        rows = [l for l in raw.decode("utf-8-sig").splitlines() if l.strip(", \t")]
        return [max(len(l.split(",")) for l in rows), len(rows)]
    lines = raw.split(b"\r\n")
    start = next(i for i, l in enumerate(lines) if l.count(b"\t") > 100)
    widths = [len(l.rstrip(b"\t").split(b"\t")) for l in lines[start:] if l.count(b"\t") > 100]
    return [min(widths), len(widths)]


def portrait(src, dst):
    from PIL import Image
    import numpy as np
    with Image.open(src) as im:
        im.load()
        if im.mode != "RGBA":
            raise SystemExit(f"{src}: 应是带屏幕遮罩（alpha）的 RGBA 图")
        alpha = im.getchannel("A")
        bbox = alpha.getbbox()
        coverage = round(int(np.count_nonzero(np.asarray(alpha))) / (im.width * im.height), 6)
        out = im.transpose(Image.Transpose.ROTATE_270)
        out.save(dst, format="PNG", optimize=True)   # lossless; smaller than the atlas's compress_level=1
        with Image.open(dst) as check:
            check.load()
            if check.mode != "RGBA" or check.size != (im.height, im.width) or check.tobytes() != out.tobytes():
                raise SystemExit(f"{dst}: 旋转后的像素与原图不一致")
        return {"sourceResolution": list(im.size), "displayResolution": list(out.size),
                "sourceMaskBounds": list(bbox) if bbox else None, "sourceMaskCoverage": coverage}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-root", required=True, help="NAS 上的 01单机数据/ 目录（只读）")
    ap.add_argument("--ids", required=True, help="视频项目里的机型 id，逗号分隔（render.py PH 或 --extra 里的）")
    ap.add_argument("--extra", help="render.py 没有列出的机型（JSON，格式见上）")
    ap.add_argument("--out", required=True, help="输出的 zip")
    ap.add_argument("--work", help="中间文件目录（默认临时目录）")
    args = ap.parse_args(argv)

    data_root = str(Path(args.data_root).resolve()) + os.sep
    ids = tuple(i for i in args.ids.split(",") if i)
    sys.path.insert(0, str(VENDOR))
    import numpy as np
    import uni
    import render

    def load(p):
        if p.lower().endswith(".csv"):
            return np.nan_to_num(np.genfromtxt(p, delimiter=",", dtype=np.float64, encoding="utf-8"), nan=0.0).astype(np.float32)
        return uni.load(p)

    render.R = data_root
    render.load = load
    if args.extra:
        for pid, name, scenes in json.loads(Path(args.extra).read_text(encoding="utf-8")):
            render.PH.append((pid, name, {lv: [tuple(x) for x in v] for lv, v in scenes.items()}))
    known = {p[0]: p for p in render.PH}
    missing = [i for i in ids if i not in known]
    if missing:
        raise SystemExit(f"render.py / --extra 里没有这些 id：{missing}")

    import export_maps
    work = Path(args.work or tempfile.mkdtemp(prefix="unif-maps-"))
    (work / "export").mkdir(parents=True, exist_ok=True)
    (work / "maps").mkdir(parents=True, exist_ok=True)
    export_maps.OUT = str(work / "export")
    export_maps.IDS = ids
    export_maps.main()
    exported = json.loads((work / "export" / "maps.json").read_text(encoding="utf-8"))

    maps = {}
    for key, meta in sorted(exported["maps"].items()):
        level, kind, sid = key.split("_", 2)
        default = known[sid][2][level][0]
        source = default[1] if kind == "lum" else default[2]
        if kind == "lum":
            metrics = {k: meta[k] for k in ("typ", "u9", "ua", "dev10")}
            scale = {"minPercentOfTypical": float(meta["lo_pct"]), "maxPercentOfTypical": float(meta["hi_pct"])}
        else:
            metrics = {k: meta[k] for k in ("typ", "d9", "da")}
            scale = {"minOffsetFromTypicalK": round(meta["lo"] - meta["typ"], 3), "maxOffsetFromTypicalK": round(meta["hi"] - meta["typ"], 3)}
        src_png = work / "export" / f"{key}.png"
        dst_png = work / "maps" / f"{key}.png"
        raster = portrait(src_png, dst_png)
        maps[key] = {
            "sourceId": sid, "name": meta["name"], "level": level, "kind": kind, "metrics": metrics, "scale": scale,
            "asset": f"maps/{key}.png", "sourceSha256": sha256(src_png), "assetSha256": sha256(dst_png), **raster,
            "measurementSource": source, "measurementSourceSha256": sha256(data_root + source),
            "measurementResolution": matrix_dimensions(data_root + source),
        }
    manifest = {
        "schemaVersion": 1,
        "tool": "pipeline/uniformity/make_maps.py",
        "vendor": {f: sha256(VENDOR / f) for f in VENDOR_FILES},
        "colorStops": exported["stops"],
        "maps": maps,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        info = zipfile.ZipInfo("manifest.json", date_time=(2026, 1, 1, 0, 0, 0))
        z.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=1) + "\n")
        for key in maps:
            info = zipfile.ZipInfo(f"maps/{key}.png", date_time=(2026, 1, 1, 0, 0, 0))
            z.writestr(info, (work / "maps" / f"{key}.png").read_bytes())
    print(f"{out}: {len(maps)} 张热力图（{', '.join(ids)}），sha256 {sha256(out)}，{out.stat().st_size} 字节")


if __name__ == "__main__":
    main()
