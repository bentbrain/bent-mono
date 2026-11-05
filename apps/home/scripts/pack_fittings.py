"""Stage fittings for visual review. --approve copies only after manual in-room QA."""
from PIL import Image, ImageFilter
import pathlib, json, math, shutil, sys, os

root=pathlib.Path(__file__).resolve().parents[1]
colors=json.loads((root/'assets/palettes/apartment-fixtures-v2.json').read_text())['colors']
rgb=[tuple(bytes.fromhex(c[1:])) for c in colors]
pal=Image.new('P',(1,1));pal.putpalette(sum((list(c) for c in rgb),[])+list(rgb[-1])*(256-len(rgb)))
sprites=root/'public/sprites'
requests=sorted((root/'runs/furniture').glob('*/request.json'))
panels=[]
for request in requests:
 info=json.loads(request.read_text());name=info['id']
 if os.environ.get('APARTMENT_MODELS') and name not in os.environ['APARTMENT_MODELS'].split(','):continue
 if not name.startswith(('kitchen-','bath-','laundry-','bedroom-')):continue
 if name.startswith('kitchen-') and name not in ['kitchen-run','kitchen-overheads']:continue
 size=info['frameSize']
 work=request.parent;views={};preview=Image.new('RGBA',(size*4,size),'#86d4e8')
 for i,direction in enumerate(['north','east','south','west']):
  filename=f'{name}-idle-{direction}.png'
  im=Image.open(work/filename).convert('RGBA');mask=im.getchannel('A').point(lambda a:255 if a>=128 else 0)
  quant=im.convert('RGB').quantize(palette=pal,dither=Image.Dither.NONE).convert('RGBA');quant.putalpha(mask)
  outline=Image.new('RGBA',im.size,'#251d2f');outline.putalpha(mask.filter(ImageFilter.MaxFilter(3)));outline.alpha_composite(quant)
  # Glass and chrome remain delicate, without a three-pixel black bar around each pipe.
  if name=='bath-shower':outline=quant
  assert outline.size==(size,size)
  box=outline.getbbox();assert box and box[0]>0 and box[1]>0 and box[2]<size and box[3]<size,(name,direction,'clipped')
  for p in outline.get_flattened_data():assert p[3] in (0,255) and (p[3]==0 or p[:3] in rgb)
  outline.save(sprites/filename)
  preview.alpha_composite(outline,(i*size,0))
  views[direction]={'source':f'public/sprites/{filename}','width':size,'height':size,'anchor':{'x':size//2,'y':size*3//4}}
 preview.save(work/'native.png');preview.resize((size*16,size*4),Image.Resampling.NEAREST).save(work/'four-views-4x.png')
 preview.crop((0,0,size,size)).resize((size*4,size*4),Image.Resampling.NEAREST).save(work/'concept-4x.png')
 panels.append(preview)
 manifest={'schemaVersion':1,'kind':'furniture','id':name,'displayName':info['name'],'footprint':info['footprint'],'heightPixels':math.ceil(info['dimensionsMetres']['height']*60.72),'palette':'apartment-fixtures-v2','views':views}
 (work/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 if '--approve' in sys.argv:
  assert (work/'in-room.png').exists(),'Missing reviewed in-room preview'
  target=root/'assets/approved'/name;target.mkdir(parents=True,exist_ok=True)
  for view in views.values():
   filename=pathlib.Path(view['source']).name;shutil.copy2(sprites/filename,target/filename);view['source']=f'assets/approved/{name}/{filename}'
  (root/'assets/manifests'/f'{name}.json').write_text(json.dumps(manifest,indent=2)+'\n')
  shutil.copy2(work/f'{name}.blend',root/'assets/source'/f'{name}.blend')
  qa=root/'assets/previews'/name;qa.mkdir(parents=True,exist_ok=True)
  for filename in ['native.png','four-views-4x.png','in-room.png']:shutil.copy2(work/filename,qa/filename)
 print(name,'pixel contract passed')
contact=Image.new('RGBA',(max(p.width for p in panels),sum(p.height for p in panels)),'#86d4e8')
y=0
for panel in panels:contact.alpha_composite(panel,(0,y));y+=panel.height
contact.save(root/'runs/assets/fittings-contact.png')
