import numpy as np, sys, os, json
from scipy import ndimage as ndi
def load(p):
    with open(p,'rb') as f: raw=f.read()
    lines=raw.split(b"\r\n")
    # header: find first line that has many tabs
    start=next(i for i,l in enumerate(lines) if l.count(b"\t")>100)
    rows=[np.array(l.rstrip(b"\t").split(b"\t"),dtype=np.float32) for l in lines[start:] if l.count(b"\t")>100]
    w=min(len(r) for r in rows); a=np.vstack([r[:w] for r in rows])
    return a
def metrics(a, erode=6):
    t0=np.percentile(a,97)
    mask=a>0.5*t0
    lab,n=ndi.label(mask)
    if n>1:
        sizes=ndi.sum(mask,lab,range(1,n+1)); mask=lab==(1+int(np.argmax(sizes)))
    full=mask.copy()
    m=ndi.binary_erosion(mask,iterations=erode) if erode else mask
    v=a[m]; typ=float(np.median(v))
    def share(vals,th): return float(np.mean(np.abs(vals/typ-1)>=th)*100)
    # smoothed (16x16 box) to suppress camera noise -> large-area mura
    am=np.where(m,a,0).astype(np.float64); k=16
    num=ndi.uniform_filter(am,k); den=ndi.uniform_filter(m.astype(np.float64),k)
    sm=np.where(den>0.999,num/np.maximum(den,1e-9),np.nan); sv=sm[~np.isnan(sm)]
    vf=a[full]
    return dict(shape=a.shape, px=int(m.sum()), typ=typ, mean=float(v.mean()),
        s10_full=float(np.mean(np.abs(vf/np.median(vf)-1)>=0.10)*100), s10=share(v,0.10), s5=share(v,0.05),
        p1=float(np.percentile(v,1)/typ*100), p99=float(np.percentile(v,99)/typ*100),
        sm_min=float(np.nanmin(sm)/typ*100), sm_max=float(np.nanmax(sm)/typ*100),
        sm_p1=float(np.percentile(sv,1)/typ*100), sm_p99=float(np.percentile(sv,99)/typ*100),
        sm_s5=float(np.mean(np.abs(sv/typ-1)>=0.05)*100), sm_s10=float(np.mean(np.abs(sv/typ-1)>=0.10)*100), sm_cv=float(sv.std()/sv.mean()*100))
if __name__=="__main__":
    for p in sys.argv[1:]:
        a=load(p); r=metrics(a)
        print(os.path.basename(p)); print("  ",json.dumps({k:(round(v,2) if isinstance(v,float) else v) for k,v in r.items()},ensure_ascii=False))
