"""均匀性统一重算和出图：读 Radiant ProMetric 导出的 txt（亮度 / 色温矩阵），
按 9 点法（VESA/IDMS）和面均匀性（参考 Black Mura）评分，输出仪器风格的 PNG 和 out/metrics.json。
用法：python3 render.py            # 全部 12 台
依赖：numpy scipy pillow。小米 18 Pro Max 的 300nits / 100nits 文件名用的是 NAS 上改正后的名字（防窥关）。"""
import numpy as np, json, sys, os
from scipy import ndimage as ndi
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from uni import load
# 数据根目录：默认指向 NAS，可用环境变量 DATA_ROOT 覆盖
R=os.environ.get("DATA_ROOT","")   # 库内副本：原文件这里是 NAS 的绝对路径，去掉了（make_maps.py 会设置 R）
# 中文字体：Linux 用 Noto Sans CJK，macOS 用 PingFang；可用环境变量 CJK_FONT 覆盖
FB=os.environ.get("CJK_FONT") or next((p for p in ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc","/System/Library/Fonts/PingFang.ttc","/System/Library/Fonts/STHeiti Medium.ttc") if os.path.exists(p)),None)
def font(sz):
    try: return ImageFont.truetype(FB,sz,index=2)
    except Exception: return ImageFont.truetype(FB,sz)
M18="小米 18 Pro Max/04源数据/均匀性/"; I18="Apple iPhone 18 Pro Max/03源文件/均匀性 260920/"; I17="Apple iPhone 17 Pro Max/04_原始数据/"
U17="小米 17 Ultra 徕卡/04原始数据/"; U15="小米 15 Ultra/04_原始数据/"; OP="一加 15/04_原始数据/"; X9U="OPPO Find X9 Ultra/04源文件/"; X9S="OPPO Find X9s Pro/05源文件/"
M80="华为 Mate 80 RS/04_原始数据/新均匀性/"; M70="华为 Mate 70 Air/04_原始数据/"; P80="华为 Pura 80 Ultra/04_原始数据/"; MV5="荣耀 Magic V5/04源文件/"
# id, name, scenes: level -> list of (cond, lum path, cct path or None)
PH=[
 ("mi18pm","小米 18 Pro Max",{"300":[("",M18+"300亮度.txt",M18+"300色温.txt")],"100":[("",M18+"100nits g20亮度.txt",M18+"100nits g20色温.txt")],
                              "10":[("",M18+"10nits g20亮度.txt",None),("防窥开",M18+"10nits g20防窥亮度.txt",None)]}),
 ("ip18pm","iPhone 18 Pro Max",{"300":[("",I18+"300nits 亮度均匀性.txt",I18+"300nits 色温均匀性.txt")],"100":[("",I18+"100nits g20 亮度均匀性.txt",I18+"100nits g20 色温均匀性.txt")],"10":[("",I18+"10nits g20 亮度均匀性.txt",None)]}),
 ("ip17pm","iPhone 17 Pro Max",{"300":[("",I17+"Apple iPhone 17 Pro Max 300NITS.txt",I17+"Apple iPhone 17 Pro Max 300NITS 色温.txt")],"100":[("",I17+"Apple iPhone 17 Pro Max 100nits g20.txt",I17+"Apple iPhone 17 Pro Max 100nits g20 色温.txt")],"10":[("",I17+"Apple iPhone 17 Pro Max 10ntis g20.txt",None)]}),
 ("mi17u","小米 17 Ultra",{"300":[("",U17+"小米17Ultra徕卡 300nits 亮度.txt",U17+"小米17Ultra徕卡 300nits 色温.txt"),("关闭自适应",U17+"小米 17Ultra徕卡 300nits 关闭自适应 亮度.txt",None)],
                          "100":[("",U17+"260106 100nits g20 亮度.txt",U17+"260106 100nits g20 色温.txt"),("关闭自适应",U17+"小米17Ultra徕卡 100nits g20 DC 亮度.txt",None)],
                          "10":[("",U17+"小米17Ultra徕卡 10nits g20 亮度.txt",None),("关闭自适应",U17+"小米 17Ultra徕卡 10nits g20 关闭自适应 亮度.txt",None)]}),
 ("mi15u","小米 15 Ultra",{"300":[("",U15+"300nits 亮度.txt",U15+"300nits 色温.txt")],"100":[("",U15+"100nits g20 亮度.txt",U15+"100nits g20 色温.txt")],"10":[("",U15+"10nits g20 亮度.txt",None)]}),
 ("op15","一加 15",{"300":[("",OP+"一加 15 300NITS.txt",OP+"一加 15 300NITS cct.txt")],"100":[("",OP+"OnePlus 15 100nits G20 亮度.txt",OP+"OnePlus 15 100nits G20 色温.txt")],"10":[("",OP+"OnePlus 15 10nits G20 亮度.txt",None)]}),
 ("x9u","OPPO Find X9 Ultra",{"300":[("",X9U+"x9u 300nits 亮度.txt",X9U+"x9u 300nits 色温.txt")],"100":[("",X9U+"x9u 100nits g20 亮度.txt",X9U+"x9u 100nits g20 色温.txt")]}),
 ("x9sp","OPPO Find X9s Pro",{"300":[("",X9S+"OPPO Find X9s Pro 300nits 亮度.txt",X9S+"OPPO Find X9s Pro 300nits 色温.txt")],"100":[("",X9S+"OPPO Find X9s Pro 100nits g20 亮度.txt",None)],"10":[("",X9S+"OPPO Find X9s Pro 10nits g20 亮度.txt",None)]}),
 ("m80rs","华为 Mate 80 RS",{"300":[("",M80+"新 华为 mate 80 rs 300nits 亮度 .txt",M80+"新 华为 mate 80 rs 300nits 色温 .txt")],"100":[("",M80+"新 华为 mate 80 rs 100nits g20 亮度.txt",M80+"新 华为 mate 80 rs 100nits g20 色温.txt")],"10":[("",M80+"新 华为 mate 80 rs 10nits g20 亮度.txt",None)]}),
 ("m70a","华为 Mate 70 Air",{"300":[("",M70+"均匀性 亮度 300nits 全屏白场.txt",M70+"均匀性 色温 300nits 全屏白场.txt")],"100":[("",M70+"均匀性 亮度 100nits g20.txt",M70+"均匀性 色温 100nits g20.txt")],"10":[("",M70+"均匀性 亮度 10nits g20.txt",None)]}),
 ("p80u","华为 Pura 80 Ultra",{"300":[("",P80+"pura80 300 w 亮度.txt",P80+"pura80 300 w 色温.txt")],"100":[("",P80+"pura80 100 gray 亮度.txt",None)],"10":[("",P80+"pura80 10 gray 亮度.txt",None)]}),
 ("mv5","荣耀 Magic V5 外屏",{"300":[("",MV5+"荣耀 Magic V5 外屏 300nits 亮度.txt",MV5+"荣耀 Magic V5 外屏 300nits 色温.txt")],"100":[("",MV5+"荣耀 Magic V5 外屏 100nits g20 亮度.txt",MV5+"荣耀 Magic V5 外屏 100nits g20 色温.txt")],"10":[("",MV5+"荣耀 Magic V5 外屏 10nits g20 亮度.txt",None)]}),
]
SCENE={"300":"300nits 白场","100":"100nits G20","10":"10nits G20"}
STOPS=[(0.00,(96,0,200)),(0.15,(24,40,255)),(0.35,(0,150,255)),(0.52,(0,232,232)),(0.68,(0,245,160)),(0.80,(96,255,0)),(0.90,(240,240,0)),(1.00,(255,150,0))]
def cmap(t):
    t=np.clip(t,0,1); out=np.zeros(t.shape+(3,),np.float32)
    xs=[s[0] for s in STOPS]
    for c in range(3): out[...,c]=np.interp(t,xs,[s[1][c] for s in STOPS])
    return out
def screen_mask(a):
    t0=np.percentile(a,97); k=max(3,int(round(a.shape[1]*0.003)))
    mask=ndi.uniform_filter(a,k)>0.3*t0   # 30% keeps dim-but-lit areas inside the outline; the bezel reads about 1%
    lab,n=ndi.label(mask)
    if n>1:
        sizes=ndi.sum(mask,lab,range(1,n+1)); mask=lab==(1+int(np.argmax(sizes)))
    ys,xs=np.where(mask); Wb=xs.max()-xs.min()+1
    hl,hn=ndi.label(ndi.binary_fill_holes(mask)&~mask)
    if hn:
        hs=ndi.sum(np.ones_like(hl),hl,range(1,hn+1))
        for i,sz in enumerate(hs,1):
            if sz<0.00012*Wb*Wb: mask[hl==i]=True
    return mask
def prep(lum_path,cct_path):
    a=load(R+lum_path).astype(np.float64); mask=screen_mask(a)
    c=None
    if cct_path:
        c=load(R+cct_path).astype(np.float64)
        if c.shape!=a.shape: print("  !! cct shape mismatch",c.shape,a.shape); c=None
    far=~ndi.binary_dilation(mask,iterations=int(mask.shape[1]*0.03))
    stray=float(np.median(a[far])) if far.sum()>2000 else float("nan")
    ys,xs=np.where(mask); pad=6
    y0,y1,x0,x1=max(ys.min()-pad,0),min(ys.max()+1+pad,a.shape[0]),max(xs.min()-pad,0),min(xs.max()+1+pad,a.shape[1])
    a=a[y0:y1,x0:x1]; mask=mask[y0:y1,x0:x1]; c=c[y0:y1,x0:x1] if c is not None else None
    if a.shape[0]>a.shape[1]:
        a=np.rot90(a); mask=np.rot90(mask); c=np.rot90(c) if c is not None else None
    holes=ndi.binary_fill_holes(mask)&~mask
    if holes.sum()>0 and np.where(holes)[1].mean()>a.shape[1]/2:
        a=a[:,::-1]; mask=mask[:,::-1]; c=c[:,::-1] if c is not None else None
    return np.ascontiguousarray(a),np.ascontiguousarray(mask),(np.ascontiguousarray(c) if c is not None else None),stray
def nfilter(v,valid,k):
    num=ndi.uniform_filter(np.where(valid,v,0.0),k); den=ndi.uniform_filter(valid.astype(np.float64),k)
    return np.where(den>0.02,num/np.maximum(den,1e-9),np.nan),den
def fill_to(vals,mask):
    """display helper: keep the full screen outline; pixels of `mask` without a value take the nearest valid value"""
    ok=np.isfinite(vals)
    if ok.all(): return vals
    idx=ndi.distance_transform_edt(~ok,return_distances=False,return_indices=True)
    out=vals[tuple(idx)]
    return np.where(mask,out,np.nan)
def nine(vals,valid,mask):
    ys,xs=np.where(mask); y0,y1,x0,x1=ys.min(),ys.max()+1,xs.min(),xs.max()+1; W,H=x1-x0,y1-y0; r=0.04*H
    yy,xx=np.mgrid[0:vals.shape[0],0:vals.shape[1]]; pts=[]
    for fy in (0.1,0.5,0.9):
        for fx in (0.1,0.5,0.9):
            cy,cx=y0+fy*H,x0+fx*W; sel=((yy-cy)**2+(xx-cx)**2<=r*r)&valid
            pts.append((cx,cy,float(vals[sel].mean()) if sel.sum()>10 else float("nan")))
    return pts,r
def analyse(a,mask,c):
    ys,xs=np.where(mask); W=xs.max()-xs.min()+1; ppm=W/160.0; k=max(3,int(round(ppm)))
    core=ndi.binary_erosion(mask,iterations=max(2,int(round(ppm*0.6))))   # drop the anti-aliased rim before filtering
    med=ndi.median_filter(a,3); f,den=nfilter(med,core,k); f=np.where(core,f,np.nan); fd=fill_to(f,mask)
    inner=ndi.binary_erosion(mask,iterations=max(2,int(round(ppm*1.5))))
    v=f[inner]; typ=float(np.median(v))
    pts,r=nine(a,mask,mask); pv=np.array([p[2] for p in pts])
    res=(a-f)[inner]; noise=float(1.4826*np.median(np.abs(res-np.median(res)))/typ*100)
    L=dict(typ=typ,u9=float(np.nanmin(pv)/np.nanmax(pv)*100),ua=float(np.percentile(v,0.1)/np.percentile(v,99.9)*100),umm=float(v.min()/v.max()*100),
           dev5=float(np.mean(np.abs(v/typ-1)>=0.05)*100),dev10=float(np.mean(np.abs(v/typ-1)>=0.10)*100),noise=noise,pts=[[p[0],p[1],p[2]/typ*100] for p in pts],r=r,W=int(W),k=k)
    C=None; cf=None; cfd=None
    if c is not None:
        ccore=ndi.binary_erosion(mask,iterations=max(3,int(round(ppm*1.2))))   # chromaticity is unreliable in the blurred edge band
        cvalid=ccore&(c>2000)&(c<15000)
        cmed=np.where(cvalid,c,np.nan)
        cf,cden=nfilter(np.nan_to_num(cmed),cvalid,k); cf=np.where(ccore,cf,np.nan); cfd=fill_to(cf,mask)
        cv=cf[inner&~np.isnan(cf)]; ctyp=float(np.median(cv))
        cpts,_=nine(c,cvalid,mask); cp=np.array([p[2] for p in cpts])
        C=dict(typ=ctyp,d9=float(np.nanmax(cp)-np.nanmin(cp)),da=float(np.percentile(cv,99.9)-np.percentile(cv,0.1)),p5=float(np.percentile(cv,97.5)-np.percentile(cv,2.5)),
               valid=float(cvalid[inner].mean()*100),pts=[[p[0],p[1],p[2]] for p in cpts],r=r)
    return L,fd,C,cfd,core
CW,CH=1600,1080; MX,MW=80,1440
def draw(kind,name,cond,lv,vals,mask,met,path):
    im=Image.new("RGB",(CW,CH),(0,0,0)); d=ImageDraw.Draw(im)
    typ=met["typ"]
    if kind=="lum":
        title="均匀性：白场亮度" if lv=="300" else "均匀性：灰阶亮度"
        if lv=="10": lo,hi=typ*0.35/0.74,typ/0.74; plo=35
        else: lo,hi=typ*0.60/0.87,typ/0.87; plo=60
        nd=1 if typ>=10 else (3 if typ>=0.1 else 4)
        lines=[f"典型值：{typ:.{1 if typ>=10 else (3 if typ>=0.1 else 4)}f}nit",f"9 点均匀性：{met['u9']:.1f}%    面均匀性：{met['ua']:.1f}%",f"相对典型值偏差≥10%占比：{met['dev10']:.2f}%"]
    else:
        title="均匀性：色温均匀性"; lo,hi=typ-1090,typ+510
        lines=[f"典型值：{typ:.0f}K",f"9 点色温差：{met['d9']:.0f}K    全屏色温差：{met['da']:.0f}K"]
    d.text((MX,34),title,font=font(46),fill=(255,255,255))
    y=104
    for s in lines: d.text((MX,y),s,font=font(27),fill=(255,255,255)); y+=40
    tag=f"{name}{'（'+cond+'）' if cond else ''}  |  {SCENE[lv]}"
    tw=d.textlength(tag,font=font(27)); d.text((CW-MX-tw,48),tag,font=font(27),fill=(255,255,255))
    # heat map
    H,W=vals.shape; mh=int(round(MW*H/W)); top=250+max(0,(640-mh)//2)
    t=(vals-lo)/(hi-lo); rgb=cmap(np.nan_to_num(t,nan=0.0)); rgb[~mask|np.isnan(vals)]=0
    hm=Image.fromarray(rgb.astype(np.uint8)).resize((MW,mh),Image.LANCZOS)
    mk=Image.fromarray((mask*255).astype(np.uint8)).resize((MW,mh),Image.LANCZOS)
    im.paste(hm,(MX,top),mk)
    # nine measurement spots
    ov=Image.new("RGBA",(CW,CH),(0,0,0,0)); od=ImageDraw.Draw(ov); s=MW/W
    pv=[p[2] for p in met["pts"]]; imin,imax=int(np.nanargmin(pv)),int(np.nanargmax(pv))
    for i,(cx,cy,val) in enumerate(met["pts"]):
        X,Y,rr=MX+cx*s,top+cy*s,met["r"]*s
        od.ellipse((X-rr,Y-rr,X+rr,Y+rr),outline=(255,255,255,230 if i in (imin,imax) else 120),width=3 if i in (imin,imax) else 2)
        if i in (imin,imax):
            lab=("最低 " if i==imin else "最高 ")+(f"{val:.1f}%" if kind=="lum" else f"{val:.0f}K")
            f18=font(20); lw=od.textlength(lab,font=f18)
            tx=min(max(X-lw/2,MX+4),MX+MW-lw-4); ty=Y+rr+4 if Y+rr+30<top+mh else Y-rr-28
            od.text((tx+1,ty+1),lab,font=f18,fill=(0,0,0,200)); od.text((tx,ty),lab,font=f18,fill=(255,255,255,255))
    im=Image.alpha_composite(im.convert("RGBA"),ov).convert("RGB"); d=ImageDraw.Draw(im)
    # colour bar
    by=CH-112; bar=cmap(np.linspace(0,1,MW)[None,:].repeat(16,0)).astype(np.uint8); im.paste(Image.fromarray(bar),(MX,by))
    f20=font(21)
    for i in range(10):
        fr=i/9; X=MX+fr*MW; v=lo+fr*(hi-lo)
        d.line((X,by-6,X,by),fill=(255,255,255),width=2)
        if kind=="lum":
            s1=f"{v:.1f}" if hi>=10 else (f"{v:.3f}" if hi>=0.1 else f"{v:.4f}"); s2=f"{plo+fr*(100-plo):.0f}%"
            w1=d.textlength(s1,font=f20); d.text((min(max(X-w1/2,4),CW-w1-4),by-36),s1,font=f20,fill=(255,255,255))
            w2=d.textlength(s2,font=f20); d.text((min(max(X-w2/2,4),CW-w2-4),by+22),s2,font=f20,fill=(255,255,255))
        else:
            s1=f"{v:.0f}K"; w1=d.textlength(s1,font=f20); d.text((min(max(X-w1/2,4),CW-w1-4),by+22),s1,font=f20,fill=(255,255,255))
    os.makedirs(os.path.dirname(path),exist_ok=True); im.save(path,optimize=True)
if __name__=="__main__":
    only=sys.argv[1] if len(sys.argv)>1 else None
    out=[]
    for pid,name,scenes in PH:
        if only and pid!=only: continue
        for lv,lst in scenes.items():
            for cond,lp,cp in lst:
                a,mask,c,stray=prep(lp,cp); L,f,C,cf,core=analyse(a,mask,c)
                fn=f"{name}{' '+cond if cond else ''}"
                p1=f"out/png/亮度 {SCENE[lv]}/{fn}.png"; draw("lum",name,cond,lv,f,mask,L,p1)
                rec=dict(id=pid,name=name,cond=cond,level=lv,kind="lum",file=p1,stray=(stray/L["typ"]*100 if stray==stray else None),**{k:v for k,v in L.items() if k not in("pts","r")})
                out.append(rec); print(f"{fn:22s} {lv:3s} lum typ {L['typ']:.4g} u9 {L['u9']:.1f} ua {L['ua']:.1f} mm {L['umm']:.1f} dev10 {L['dev10']:.2f} noise {L['noise']:.1f}",flush=True)
                if C:
                    p2=f"out/png/色温 {SCENE[lv]}/{fn}.png"; draw("cct",name,cond,lv,cf,mask,C,p2)
                    out.append(dict(id=pid,name=name,cond=cond,level=lv,kind="cct",file=p2,**{k:v for k,v in C.items() if k not in("pts","r")}))
                    print(f"{'':22s} {lv:3s} cct typ {C['typ']:.0f} d9 {C['d9']:.0f} da {C['da']:.0f} p2.5-97.5 {C['p5']:.0f} valid {C['valid']:.0f}%",flush=True)
    json.dump(out,open("out/metrics.json" if not only else f"out/metrics_{only}.json","w"),ensure_ascii=False,indent=0)
