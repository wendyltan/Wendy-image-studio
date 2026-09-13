"""Deterministic Chinese lettering, screen compositing, and page export."""
import sys, json, math, zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter
FONT='/System/Library/Fonts/STHeiti Light.ttc'
FONT_MEDIUM='/System/Library/Fonts/STHeiti Medium.ttc'
BG='#f7f1e7'; INK='#4f4037'; BORDER='#8f7664'
def font(size): return ImageFont.truetype(FONT,size)
def medium(size): return ImageFont.truetype(FONT_MEDIUM,size)
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
    # Past approved pages use almost the full sheet, narrow gutters and rounded
    # panels. Text floats inside the picture instead of creating form-like rows.
    x,y,w,h,g=22,22,1036,1360,12
    mode=page['layout']
    if mode=='solo': return [(x,y,w,h)]
    if mode=='duo':
        a=round((h-g)*.63);return [(x,y,w,a),(x,y+a+g,w,h-a-g)]
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
        x,y,w,h=box;max_text_width=max(180,min(w-56,round(w*.62)));lines=wrap(panel['caption'],max_text_width-34)
        if len(lines)>6: raise ValueError('文案过长，请减少文字或改用更大的分镜。')
        out.append({'box':list(box),'width':w-2,'height':h-2,'lines':lines,'ratio':round((w-2)/(h-2),4)})
    return out
def rounded_paste(canvas,im,box,radius=23):
    x,y,w,h=box;im=ImageOps.fit(im,(w-2,h-2),method=Image.Resampling.LANCZOS)
    mask=Image.new('L',(w-2,h-2),0);ImageDraw.Draw(mask).rounded_rectangle((0,0,w-3,h-3),radius=max(3,radius-1),fill=255)
    canvas.paste(im,(x+1,y+1),mask)
def caption_box(canvas,panel,lines,box,index):
    if not lines:return
    x,y,w,h=box;size=24;f=font(size);line_h=33
    text_w=max(f.getlength(line) for line in lines);bw=min(w-28,math.ceil(text_w)+36);bh=len(lines)*line_h+22
    kind=panel.get('captionKind','narration')
    if kind=='time': bx=x+w-bw-16;by=y+16
    elif kind=='dialogue': bx=x+w-bw-16;by=y+18
    elif index%2: bx=x+16;by=y+18
    else: bx=x+16;by=y+h-bh-18
    layer=Image.new('RGBA',canvas.size,(0,0,0,0));ld=ImageDraw.Draw(layer,'RGBA')
    ld.rounded_rectangle((bx+3,by+5,bx+bw+3,by+bh+5),radius=16,fill=(65,46,34,34))
    fill=(250,247,239,238) if kind!='time' else (242,238,226,235)
    ld.rounded_rectangle((bx,by,bx+bw,by+bh),radius=16,fill=fill,outline=(105,82,66,155),width=1)
    for i,line in enumerate(lines):ld.text((bx+18,by+9+i*line_h),line,font=f,fill=(65,49,40,255))
    canvas.paste(layer,(0,0),layer)
def page_title(canvas,page):
    title=str(page.get('title','')).strip()
    if not title:return
    x,y,w,_=boxes(page)[0];f=medium(25)
    while f.getlength(title)>min(520,w-72) and f.size>19:f=medium(f.size-1)
    bw=math.ceil(f.getlength(title))+34;bh=48
    layer=Image.new('RGBA',canvas.size,(0,0,0,0));d=ImageDraw.Draw(layer,'RGBA')
    d.rounded_rectangle((x+16,y+16,x+16+bw,y+16+bh),radius=15,fill=(250,247,239,236),outline=(105,82,66,145),width=1)
    d.text((x+33,y+24),title,font=f,fill=(65,49,40,255));canvas.paste(layer,(0,0),layer)
def compose(spec):
    page=spec['page'];canvas=Image.new('RGB',(1080,1440),BG);d=ImageDraw.Draw(canvas)
    for index,(p,g,file) in enumerate(zip(page['panels'],geometry(page),spec['images'])):
        im=ImageOps.exif_transpose(Image.open(file)).convert('RGB');w,h=g['width'],g['height']
        discrepancy=abs((im.width/im.height)/(w/h)-1)
        # Small edge trimming is covered by the prompt's 8% safe area. Never distort or pad.
        if discrepancy>.18:raise ValueError(f'原图比例不适合分镜（目标 {w}:{h}），请重新生成合适比例的画面。')
        x,y,bw,bh=g['box'];rounded_paste(canvas,im,(x,y,bw,bh));d.rounded_rectangle((x,y,x+bw,y+bh),radius=23,outline=BORDER,width=2)
        caption_box(canvas,p,g['lines'],(x,y,bw,bh),index)
    page_title(canvas,page)
    d=ImageDraw.Draw(canvas);num=f"{page['number']:02d}";nf=font(16)
    d.rounded_rectangle((1004,1389,1058,1427),radius=16,fill='#f7f1e7',outline='#a58c78',width=1)
    d.text((1031-nf.getlength(num)/2,1397),num,font=nf,fill='#765f50')
    dest=Path(spec['output']);dest.parent.mkdir(parents=True,exist_ok=True);canvas.save(dest,format='PNG')
    with Image.open(dest) as check:
        assert check.size==(1080,1440) and check.mode=='RGB' and check.format=='PNG'
    return str(dest)
def prepare_web(spec):
    outdir=Path(spec['outputDir']);outdir.mkdir(parents=True,exist_ok=True);result=[]
    for index,value in enumerate(spec['files']):
        source=Path(value);im=ImageOps.exif_transpose(Image.open(source));largest=max(im.size)
        if source.stat().st_size<=1_200_000 and largest<=1600:
            result.append({'source':str(source),'file':str(source),'optimized':False,'sizeBytes':source.stat().st_size});continue
        im=im.convert('RGB')
        if largest>1600:
            scale=1600/largest;im=im.resize((max(1,round(im.width*scale)),max(1,round(im.height*scale))),Image.Resampling.LANCZOS)
        target=outdir/f'{index+1:02d}-{source.stem}.jpg';im.save(target,'JPEG',quality=90,optimize=True,progressive=True)
        result.append({'source':str(source),'file':str(target),'optimized':True,'sizeBytes':target.stat().st_size})
    return result
def screen(spec):
    import cv2, numpy as np
    source=Path(spec['input']);orig=ImageOps.exif_transpose(Image.open(source)).convert('RGB');ow,oh=orig.size
    points=spec['corners'];raw_pts=np.float32([[float(p['x']),float(p['y'])] for p in points])
    pts=raw_pts.copy()
    if len(pts)!=4 or np.any(pts[:,0]<0) or np.any(pts[:,0]>=ow) or np.any(pts[:,1]<0) or np.any(pts[:,1]>=oh):raise ValueError('内屏定位超出原图范围。')
    # TL, TR, BR, BL is part of the locator contract.
    area=abs(cv2.contourArea(pts.astype(np.float32)))
    if area<ow*oh*.002:raise ValueError('内屏区域过小，无法可靠排字。')
    # Keep a narrow rim of the original glass and bezel visible even when the
    # visual locator returns the outside edge of the display.
    center=pts.mean(axis=0);pts=center+(pts-center)*.955
    top=np.linalg.norm(pts[1]-pts[0]);bottom=np.linalg.norm(pts[2]-pts[3]);left=np.linalg.norm(pts[3]-pts[0]);right=np.linalg.norm(pts[2]-pts[1])
    target_w=max(top,bottom);target_h=max(left,right)
    W=max(720,min(1600,round(target_w*5)));H=max(520,min(1400,round(target_h*5)))
    ui=Image.new('RGB',(W,H),(248,249,250));d=ImageDraw.Draw(ui)
    title='Codex' if 'Codex' in spec.get('screenText','') or 'codex' in spec.get('screenDirection','').lower() else '会话'
    projected_text_px=max(15,min(19,round(target_h*.085)));scale_y=H/target_h
    text_size=round(projected_text_px*scale_y);title_size=round(max(13,projected_text_px*.82)*scale_y)
    header_h=round(H*.13);d.rectangle((0,0,W,header_h),fill=(239,241,244));d.text((round(W*.045),round(H*.027)),title,font=medium(title_size),fill=(38,41,46))
    lines=[line.strip() for line in str(spec.get('screenText','')).splitlines() if line.strip() and line.strip().lower()!=title.lower()]
    if not lines:raise ValueError('内屏没有可排版的冻结文字。')
    y=round(H*.17);pad=round(W*.035);f=medium(text_size);line_h=round(text_size*1.24);rendered=[]
    for index,line in enumerate(lines):
        wrapped=wrap(line,W-2*pad-round(W*.055),text_size);rendered.extend(wrapped);height=len(wrapped)*line_h+round(H*.045)
        fill=(231,237,247) if index%2==0 else (241,242,244)
        d.rounded_rectangle((pad,y,W-pad,y+height),radius=max(12,round(H*.022)),fill=fill)
        for row,text in enumerate(wrapped):d.text((pad+round(W*.025),y+round(H*.018)+row*line_h),text,font=f,fill=(28,31,36))
        y+=height+round(H*.035)
    if y>H-round(H*.025):raise ValueError('内屏文案过长，无法在保持清晰字高的情况下完整排入。')
    arr=np.array(ui).astype(np.float32);dst=np.float32([[0,0],[W,0],[W,H],[0,H]])
    matrix=cv2.getPerspectiveTransform(dst,pts);base=np.array(orig).astype(np.float32)
    warped=cv2.warpPerspective(arr,matrix,(ow,oh),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_CONSTANT)
    mask=np.zeros((oh,ow),np.uint8);cv2.fillConvexPoly(mask,pts.astype(np.int32),255);mask=cv2.erode(mask,np.ones((3,3),np.uint8),iterations=1)
    soft=cv2.GaussianBlur(mask,(0,0),1.2).astype(np.float32)/255.0;lum=cv2.cvtColor(base.astype(np.uint8),cv2.COLOR_RGB2GRAY).astype(np.float32)/255.0
    alpha=(soft*.95)[...,None];mixed=base*(1-alpha)+np.clip(warped*(.94+.10*lum[...,None]),0,255)*alpha
    output=Path(spec['output']);output.parent.mkdir(parents=True,exist_ok=True);Image.fromarray(np.uint8(np.clip(mixed,0,255))).save(output,'PNG')
    return {'output':str(output),'sourceSize':[ow,oh],'corners':points,'contentCorners':[{'x':round(float(x),2),'y':round(float(y),2)} for x,y in pts],'outsidePixelsPreserved':True,'screenText':spec.get('screenText',''),'renderedLines':rendered,'projectedTextPx':projected_text_px,'font':FONT_MEDIUM}
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
    elif mode=='prepare-web':print(json.dumps(prepare_web(data),ensure_ascii=False))
    elif mode=='screen':print(json.dumps(screen(data),ensure_ascii=False))
    elif mode=='zip':
        with zipfile.ZipFile(data['output'],'w',zipfile.ZIP_DEFLATED) as z:
            for p in data['files']:z.write(p,Path(p).name)
        with zipfile.ZipFile(data['output']) as z:assert z.testzip() is None
        print(data['output'])
if __name__=='__main__':main()
