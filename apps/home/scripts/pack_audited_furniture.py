"""Pack staged four-view sprites. --approve requires completed visual review."""
from PIL import Image,ImageFilter,ImageDraw
import pathlib,json,shutil,sys,math,os
root=pathlib.Path(__file__).resolve().parents[1];specs=json.loads((root/'data/furniture-audit.json').read_text())+json.loads((root/'data/photo-objects.json').read_text());previews=[]
colors=json.loads((root/'assets/palettes/apartment-fixtures-v2.json').read_text())['colors'];rgb=[tuple(bytes.fromhex(c[1:])) for c in colors];pal=Image.new('P',(1,1));pal.putpalette(sum((list(c) for c in rgb),[])+list(rgb[-1])*(256-len(rgb)))
for spec in specs:
 name=spec['id'];work=root/'runs/furniture'/name
 if os.environ.get('APARTMENT_MODELS') and name not in os.environ['APARTMENT_MODELS'].split(','):continue
 frame_width=256 if name=='checker-rug' else 240
 frame_height=256 if name=='checker-rug' else 240
 sheet=Image.new('RGBA',(frame_width*4,frame_height+20),'#86d4e8');views={}
 for q,direction in enumerate(['north','east','south','west']):
  im=Image.open(work/f'{name}-{direction}.png').convert('RGBA');mask=im.getchannel('A').point(lambda x:255 if x>=128 else 0)
  quant=im.convert('RGB').quantize(palette=pal,dither=Image.Dither.NONE).convert('RGBA');quant.putalpha(mask)
  border=Image.new('RGBA',im.size,'#303635');border.putalpha(mask.filter(ImageFilter.MaxFilter(3)));border.alpha_composite(quant)
  filename=f'{name}-idle-{direction}.png';border.save(root/'public/sprites'/filename);sheet.alpha_composite(border,(q*frame_width,20))
  views[direction]={'source':f'assets/approved/{name}/{filename}','anchor':{'x':frame_width//2,'y':round(frame_height*.75)},'width':frame_width,'height':frame_height}
  if q==0:
   crop=border.crop(border.getbbox());thumb=Image.new('RGBA',(128,128));factor=max(1,math.floor(120/max(crop.size))) if name=='downlight' else min(1,120/max(crop.size));crop=crop.resize((max(1,int(crop.width*factor)),max(1,int(crop.height*factor))),Image.Resampling.NEAREST);thumb.alpha_composite(crop,((128-crop.width)//2,(128-crop.height)//2));thumb.save(root/'public/sprites'/f'{name}-catalogue.png')
 ImageDraw.Draw(sheet).text((8,4),name+' | '+str(spec['w'])+' x '+str(spec['d'])+' x '+str(spec['h'])+' m',fill='#303635')
 sheet.save(work/'qa.png');sheet.resize((sheet.width*4,sheet.height*4),Image.Resampling.NEAREST).save(work/'qa-4x.png');previews.append(sheet)
 manifest={'schemaVersion':1,'kind':'furniture','id':name,'displayName':spec['name'],'footprint':{'width':math.ceil(spec['w']/.25),'depth':math.ceil(spec['d']/.25)},'heightPixels':math.ceil(spec['h']*60.72),'palette':'apartment-fixtures-v2','views':views}
 (work/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 if '--approve' in sys.argv:
  assert (work/'in-room.png').exists(),name+' needs in-room review'
  target=root/'assets/approved'/name;target.mkdir(parents=True,exist_ok=True)
  for direction in views:shutil.copy2(root/'public/sprites'/f'{name}-idle-{direction}.png',target)
  shutil.copy2(work/'manifest.json',root/'assets/manifests'/f'{name}.json');shutil.copy2(work/f'{name}.blend',root/'assets/source'/f'{name}.blend');shutil.copy2(work/'qa.png',root/'assets/previews'/f'{name}.png');shutil.copy2(work/'qa-4x.png',root/'assets/previews'/f'{name}-4x.png');shutil.copy2(work/'in-room.png',root/'assets/previews'/f'{name}-in-room.png')
contact=Image.new('RGB',(max(p.width for p in previews),max(p.height for p in previews)*len(previews)),'#86d4e8')
for i,im in enumerate(previews):contact.paste(im,(0,i*max(p.height for p in previews)),im)
contact.save(root/'runs/furniture-audit/contact.png')
# Historical items still use their existing four-view sources; only centre their catalogue thumbnails.
for name in ['okensand','sofa','table','vacuum']:
 p=root/'public/sprites'/f'{name}-idle-north.png'
 im=Image.open(p).convert('RGBA');crop=im.crop(im.getbbox());factor=min(1,120/max(crop.size));crop=crop.resize((max(1,int(crop.width*factor)),max(1,int(crop.height*factor))),Image.Resampling.NEAREST);thumb=Image.new('RGBA',(128,128));thumb.alpha_composite(crop,((128-crop.width)//2,(128-crop.height)//2));thumb.save(root/'public/sprites'/f'{name}-catalogue.png')
import hashlib
p=root/'public/models/manifest.json';manifest=json.loads(p.read_text());manifest['spriteHashes']={p.stem:hashlib.sha256(p.read_bytes()).hexdigest()[:12] for p in (root/'public/sprites').glob('*-catalogue.png')};p.write_text(json.dumps(manifest,indent=2)+'\n')
print('Packed',len(specs),'four-view models')
