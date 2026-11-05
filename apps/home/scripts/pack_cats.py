"""Quantize and review rigged cat strips; approval is an explicit separate step."""
from PIL import Image,ImageFilter
import pathlib,json,sys,shutil
root=pathlib.Path(__file__).resolve().parents[1]
colors=json.loads((root/'assets/palettes/apartment-fixtures-v2.json').read_text())['colors'];rgb=[tuple(bytes.fromhex(c[1:])) for c in colors]
pal=Image.new('P',(1,1));pal.putpalette(sum((list(c) for c in rgb),[])+list(rgb[-1])*(256-len(rgb)))
concept='--concept' in sys.argv
for pet in ['pearl','maree']:
 name=pet+'-v3';work=root/'runs/characters'/name;animations={};native=Image.new('RGBA',(384,96*7),'#86d4e8')
 for ai,anim in enumerate(['idle'] if concept else ['idle','walk','sit','sleep','groom','jump','crouch']):
  views={};animation_panels=[]
  for di,direction in enumerate(['north','east','south','west']):
   count=1 if concept else 8;strip=Image.new('RGBA',(96*count,96))
   for frame in range(count):
    im=Image.open(work/f'{anim}-{direction}-{frame}.png').convert('RGBA');mask=im.getchannel('A').point(lambda a:255 if a>=128 else 0)
    quant=im.convert('RGB').quantize(palette=pal,dither=Image.Dither.NONE).convert('RGBA');quant.putalpha(mask)
    out=Image.new('RGBA',(240,240),'#4e5656');out.putalpha(mask.filter(ImageFilter.MaxFilter(3)));out.alpha_composite(quant)
    for p in out.get_flattened_data():assert p[3] in (0,255) and (p[3]==0 or p[:3] in rgb)
    box=out.getbbox();assert box and min(box[:2])>0 and max(box[2:])<240
    assert out.getbbox()[0]>=72 and out.getbbox()[1]>=108 and out.getbbox()[2]<=168 and out.getbbox()[3]<=204
    strip.alpha_composite(out.crop((72,108,168,204)),(frame*96,0))
   native.alpha_composite(strip.crop((0,0,96,96)),(di*96,ai*96))
   filename=f'{name}-{anim}-{direction}.png'
   strip.save(work/filename)
   if not concept:shutil.copy2(work/filename,root/'public/sprites'/filename)
   views[direction]={'source':f'public/sprites/{filename}','anchor':{'x':48,'y':72},'frameWidth':96,'frameHeight':96,'frameCount':count,'framesPerSecond':12 if anim=='walk' else 8}
   animation_panels.append(strip)
  if not concept:
   panel=Image.new('RGBA',(768,384),'#86d4e8')
   for i,strip in enumerate(animation_panels):panel.alpha_composite(strip,(0,i*96))
   panel.save(work/f'{anim}-native.png');panel.resize((3072,1536),Image.Resampling.NEAREST).save(work/f'{anim}-4x.png')
  animations[anim]=views
 if concept:
  native=native.crop((0,0,384,96));native.save(work/'concept-native.png');native.resize((1536,384),Image.Resampling.NEAREST).save(work/'concept-4x.png');continue
 native.save(work/'turnarounds.png')
 manifest={'schemaVersion':1,'kind':'character','id':name,'displayName':pet.title(),'footprint':{'width':1,'depth':4},'palette':'apartment-fixtures-v2','animations':animations}
 (work/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 if '--approve' in sys.argv:
  assert (work/'in-room.png').exists() and (work/'motion.gif').exists()
  target=root/'assets/approved'/name;target.mkdir(parents=True,exist_ok=True)
  for views in animations.values():
   for view in views.values():
    filename=pathlib.Path(view['source']).name;shutil.copy2(work/filename,target/filename);view['source']=f'assets/approved/{name}/{filename}'
  (root/'assets/manifests'/f'{name}.json').write_text(json.dumps(manifest,indent=2)+'\n')
  shutil.copy2(work/f'{name}.blend',root/'assets/source'/f'{name}.blend')
  preview=root/'assets/previews'/name;preview.mkdir(parents=True,exist_ok=True)
  for filename in ['turnarounds.png','in-room.png','motion.gif','motion-native.gif']+[a+'-4x.png' for a in animations]:shutil.copy2(work/filename,preview/filename)
 print(name,'28 authored strips validated')
