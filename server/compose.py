"""Deterministic Chinese lettering and 1080 x 1440 RGB page export."""
import sys, json, math, zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
FONT='/System/Library/Fonts/STHeiti Light.ttc'
BG='#fcf8f0'; INK='#594a40'; BORDER='#c2b29c'
def font(size): return ImageFont.truetype(FONT,size)
def wrap(text,width,size=24):
    f=font(size); lines=[]
    for paragraph in text.split('\n'):
        line=''
        for char in paragraph:
            if line and f.getlength(line+char)>width: lines.append(line); line=char
            else: line+=char
        lines.append(line)
    return lines if text else []
def boxes(page):
    x,y,w,h,g=22,84,1036,1300,16
    mode=page['layout']
    if mode=='solo': return [(x,y,w,h)]
    if mode=='duo':
        a=round((h-g)*.61);return [(x,y,w,a),(x,y+a+g,w,h-a-g)]
    if mode=='montage':
        hs=[round((h-2*g)*v) for v in [.40,.27,.33]]; hs[-1]=h-2*g-sum(hs[:-1]); out=[]
        for height in hs: out.append((x,y,w,height));y+=height+g
        return out
    if mode in ['trio','four']:
        n=2 if mode=='trio' else 3; a=round((h-g)*.58);b=h-a-g;cw=(w-(n-1)*g)//n
        return [(x,y,w,a)]+[(x+i*(cw+g),y+a+g,cw if i<n-1 else w-i*(cw+g),b) for i in range(n)]
    raise ValueError('不支持的分镜版式')
def geometry(page):
    out=[]
    for panel,box in zip(page['panels'],boxes(page)):
        x,y,w,h=box;lines=wrap(panel['caption'],w-36)
        cap=0 if not lines else 22+len(lines)*34
        if cap>h*.37: raise ValueError('文案过长，请减少文字或改用更大的分镜。')
        ih=h-cap
        if ih<140: raise ValueError('分镜可用画面太小。')
        out.append({'box':list(box),'width':w-2,'height':ih-2,'captionHeight':cap,'lines':lines,'ratio':round((w-2)/(ih-2),4)})
    return out
def compose(spec):
    page=spec['page'];canvas=Image.new('RGB',(1080,1440),BG);d=ImageDraw.Draw(canvas)
    title=page['title']; ts=32
    while font(ts).getlength(title)>1030 and ts>20:ts-=1
    if font(ts).getlength(title)>1030: raise ValueError('页面标题过长，请缩短标题。')
    d.text((22,29),title,font=font(ts),fill=INK)
    for p,g,file in zip(page['panels'],geometry(page),spec['images']):
        im=ImageOps.exif_transpose(Image.open(file)).convert('RGB');w,h=g['width'],g['height']
        discrepancy=abs((im.width/im.height)/(w/h)-1)
        # Small edge trimming is covered by the prompt's 8% safe area. Never distort or pad.
        if discrepancy>.16:raise ValueError(f'原图比例不适合分镜（目标 {w}:{h}），请重新生成合适比例的画面。')
        im=ImageOps.fit(im,(w,h),method=Image.Resampling.LANCZOS)
        x,y,bw,bh=g['box'];canvas.paste(im,(x+1,y+1));d.rectangle((x,y,x+bw,y+bh),outline=BORDER,width=1)
        if g['lines']:
            longest=max(font(24).getlength(line) for line in g['lines']);cw=min(bw-12,math.ceil(longest)+28)
            cy=y+g['height']+7;ch=g['captionHeight']-10
            color='#e9eee4' if p['captionKind']=='time' else '#fffefb' if p['captionKind']=='dialogue' else '#fffaf0'
            d.rounded_rectangle((x+6,cy,x+6+cw,cy+ch),radius=12 if p['captionKind']=='dialogue' else 6,fill=color,outline=INK if p['captionKind']=='dialogue' else BORDER,width=1)
            for i,line in enumerate(g['lines']):d.text((x+20,cy+6+i*34),line,font=font(24),fill=INK)
    d.text((22,1405),'温蒂的日常',font=font(17),fill='#8d7b6a')
    num=f"{page['number']:02d} / {spec['total']:02d}";d.text((1058-font(17).getlength(num),1405),num,font=font(17),fill=INK)
    dest=Path(spec['output']);dest.parent.mkdir(parents=True,exist_ok=True);canvas.save(dest,format='PNG')
    with Image.open(dest) as check:
        assert check.size==(1080,1440) and check.mode=='RGB' and check.format=='PNG'
    return str(dest)
def main():
    mode=sys.argv[1]
    if mode=='info':
        with Image.open(sys.argv[2]) as im: im.verify()
        with Image.open(sys.argv[2]) as im:
            im.load()
            print(json.dumps({'width':im.width,'height':im.height,'mode':im.mode,'format':im.format}))
            return
    data=json.loads(Path(sys.argv[2]).read_text())
    if mode=='geometry': print(json.dumps(geometry(data),ensure_ascii=False))
    elif mode=='compose':print(compose(data))
    elif mode=='zip':
        with zipfile.ZipFile(data['output'],'w',zipfile.ZIP_DEFLATED) as z:
            for p in data['files']:z.write(p,Path(p).name)
        with zipfile.ZipFile(data['output']) as z:assert z.testzip() is None
        print(data['output'])
if __name__=='__main__':main()
