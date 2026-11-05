from PIL import Image,ImageFilter
import pathlib,json,shutil,sys,os
root=pathlib.Path(__file__).resolve().parents[1];work=root/'runs/assets';out=root/'public/sprites';out.mkdir(exist_ok=True,parents=True)
palette=json.loads((root/'assets/palettes/apartment-hotel-v1.json').read_text())['colors'];rgb=[tuple(bytes.fromhex(c[1:])) for c in palette]
pal=Image.new('P',(1,1));pal.putpalette(sum((list(c) for c in rgb),[])+list(rgb[-1])*(256-len(rgb)))
previews=[]
for name in ['dyvlinge','perjohan','byakorre','kirribilli','okensand','gullsudare','sofa','table','vacuum','pearl','maree']:
 if os.environ.get('APARTMENT_MODELS') and name not in os.environ['APARTMENT_MODELS'].split(','):continue
 if '--furniture-only' in sys.argv and name in ['pearl','maree']:continue
 animations=['idle','walk','sit','sleep','groom'] if name in ['pearl','maree'] else ['idle'];rows=[]
 for anim in animations:
  for direction in ['north','east','south','west']:
   frames=[]
   for frame in range(2 if name in ['pearl','maree'] else 1):
    p=work/f'{name}-{anim}-{direction}-{frame}.png'
    if not p.exists():raise RuntimeError(f'Render missing: {p}')
    im=Image.open(p).convert('RGBA');mask=im.getchannel('A').point(lambda x:255 if x>=128 else 0)
    quant=im.convert('RGB').quantize(palette=pal,dither=Image.Dither.NONE).convert('RGBA');quant.putalpha(mask)
    # One-pixel outline follows the rendered silhouette, never resamples a view.
    border=Image.new('RGBA',im.size,'#251d2f');border.putalpha(mask.filter(ImageFilter.MaxFilter(3)));border.alpha_composite(quant);frames.append(border)
   sheet=Image.new('RGBA',(240*len(frames),240))
   for n,im in enumerate(frames):sheet.paste(im,(n*240,0))
   sheet.save(out/f'{name}-{anim}-{direction}.png');rows.append(sheet)
 preview=Image.new('RGBA',(960,240*len(animations)), '#86d4e8')
 for i,row in enumerate(rows):preview.alpha_composite(row.crop((0,0,240,240)),((i%4)*240,(i//4)*240))
 preview.save(work/f'{name}-qa.png');previews.append(preview.crop((0,0,960,240)))
contact=Image.new('RGB',(960,len(previews)*240),'#86d4e8')
for i,im in enumerate(previews):contact.paste(im,(0,i*240),im)
contact.save(work/'all-models.png')
print('Packed four-view models and character strips')
