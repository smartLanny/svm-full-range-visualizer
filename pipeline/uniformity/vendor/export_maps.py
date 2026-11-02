"""F5–F7 动画用：导出三台手机（小米 18 Pro Max / 小米 17 Ultra / iPhone 18 Pro Max）均匀性的“干净”热力图。
和 render.py 用同一套读数、滤波和评分（prep / analyse），只是不画文字：透明背景、屏幕外透明，
文字和数字由 scenes/F05_uniformity.html 排版。

输出：data/unif/<场景>_<lum|cct>_<id>.png（1440 宽）和 data/unif/maps.json（数值、色条范围、9 点位置）
用法：python3 tools/uniformity/export_maps.py
"""
import json, os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scipy import ndimage as ndi
from render import PH, prep, analyse, cmap, fill_to

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "unif")
IDS = ("mi18pm", "mi17u", "ip18pm")
W_OUT = 1440


def save_map(vals, mask, lo, hi, path):
    t = (vals - lo) / (hi - lo)
    rgb = cmap(np.nan_to_num(t, nan=0.0))
    alpha = (mask & np.isfinite(vals)).astype(np.float32) * 255
    im = Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA")
    h = round(W_OUT * vals.shape[0] / vals.shape[1])
    im.resize((W_OUT, h), Image.LANCZOS).save(path, optimize=True)
    return h


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = {}
    for pid, name, scenes in PH:
        if pid not in IDS:
            continue
        for lv, lst in scenes.items():
            cond, lp, cp = lst[0]                       # 默认设置那一组（不是“关闭自适应”“防窥开”）
            a, mask, c, _ = prep(lp, cp)
            L, f, C, cf, _ = analyse(a, mask, c)
            # 只影响画面：屏幕边缘 1.5mm 内的读数被相机模糊带进了边框的暗部（18 Pro Max 的测量图分辨率只有另外两台一半，
            # 边上一圈发暗、看着发虚，Lann 10-05）。和评分用的 inner 区域一样往里收 1.5mm，外面用最近的有效值填到屏幕轮廓；数值不变
            ppm = L["W"] / 160.0
            f = fill_to(np.where(ndi.binary_erosion(mask, iterations=max(2, int(round(ppm * 1.5)))), f, np.nan), mask)
            typ = L["typ"]
            lo, hi = (typ * 0.35 / 0.74, typ / 0.74) if lv == "10" else (typ * 0.60 / 0.87, typ / 0.87)   # 和 render.py 同一个色条
            H, W = f.shape
            key = f"{lv}_lum_{pid}"
            h = save_map(f, mask, lo, hi, os.path.join(OUT, key + ".png"))
            meta[key] = dict(name=name, level=lv, kind="lum", typ=typ, u9=L["u9"], ua=L["ua"], dev10=L["dev10"],
                             lo_pct=round(lo / typ * 100, 2), hi_pct=round(hi / typ * 100, 2), aspect=W / H,
                             pts=[[p[0] / W, p[1] / H, p[2]] for p in L["pts"]], r=L["r"] / W)
            if C:
                lo, hi = C["typ"] - 1090, C["typ"] + 510
                key = f"{lv}_cct_{pid}"
                save_map(cf, mask, lo, hi, os.path.join(OUT, key + ".png"))
                meta[key] = dict(name=name, level=lv, kind="cct", typ=C["typ"], d9=C["d9"], da=C["da"], lo=lo, hi=hi, aspect=W / H,
                                 pts=[[p[0] / W, p[1] / H, p[2]] for p in C["pts"]], r=C["r"] / W)
            print(name, lv, "u9 %.1f ua %.1f" % (L["u9"], L["ua"]), "cct d9 %.0f" % C["d9"] if C else "")
    stops = __import__("render").STOPS
    json.dump({"maps": meta, "stops": stops}, open(os.path.join(OUT, "maps.json"), "w"), ensure_ascii=False, indent=1)
    open(os.path.join(OUT, "maps.js"), "w").write("window.UNIF = " + json.dumps({"maps": meta, "stops": stops}, ensure_ascii=False) + ";\n")


if __name__ == "__main__":
    main()
