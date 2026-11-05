"""Package visually reviewed Blender-derived assets and validate their pixel contract."""
from PIL import Image
import json,pathlib,shutil,math,sys,os
root=pathlib.Path(__file__).resolve().parents[1];work=root/'runs/assets';sprites=root/'public/sprites'
palette={tuple(bytes.fromhex(c[1:])) for c in json.loads((root/'assets/palettes/apartment-hotel-v1.json').read_text())['colors']}
products={'dyvlinge':(.63,.75,.68),'perjohan':(1,.28,.45),'byakorre':(1.4,.32,1.62),'kirribilli':(1.56,2.12,.96),'okensand':(.48,.48,1.54),'gullsudare':(.7,.7,2),'sofa':(2.1,.9,.94),'table':(1.3,.8,.77),'vacuum':(.35,.35,.15),'pearl':(.35,.7,.58),'maree':(.35,.7,.58)}
for name,(w,d,h) in products.items():
 if os.environ.get('APARTMENT_MODELS') and name not in os.environ['APARTMENT_MODELS'].split(','):continue
 if '--furniture-only' in sys.argv and name in ['pearl','maree']:continue
 target=root/'assets/approved'/name;target.mkdir(parents=True,exist_ok=True)
 character=name in ['pearl','maree'];animations=['idle','walk','sit','sleep','groom'] if character else ['idle'];manifest={'schemaVersion':1,'kind':'character' if character else 'furniture','id':name,'displayName':name.title(),'footprint':{'width':math.ceil(w/.25),'depth':math.ceil(d/.25)},'palette':'apartment-hotel-v1'}
 if character:manifest['animations']={}
 else:manifest['heightPixels']=math.ceil(h*60.72);manifest['views']={}
 for anim in animations:
  views={}
  for direction in ['north','east','south','west']:
   filename=f'{name}-{anim}-{direction}.png';im=Image.open(sprites/filename).convert('RGBA')
   for pixel in im.get_flattened_data():
    assert pixel[3] in (0,255),(name,'partial alpha')
    assert pixel[3]==0 or pixel[:3] in palette,(name,'off palette',pixel)
   assert im.size==((480 if character else 240),240)
   shutil.copy2(sprites/filename,target/filename)
   base={'source':str((target/filename).relative_to(root)),'anchor':{'x':120,'y':180}}
   if character:base.update(frameWidth=240,frameHeight=240,frameCount=2,framesPerSecond=4)
   else:base.update(width=240,height=240)
   views[direction]=base
  if character:manifest['animations'][anim]=views
  else:manifest['views']=views
 for path in ['assets/manifests','assets/source','assets/previews']:(root/path).mkdir(parents=True,exist_ok=True)
 (root/'assets/manifests'/f'{name}.json').write_text(json.dumps(manifest,indent=2)+'\n')
 shutil.copy2(work/f'{name}.blend',root/'assets/source'/f'{name}.blend')
 shutil.copy2(work/f'{name}-qa.png',root/'assets/previews'/f'{name}.png')
 print(name,'all four views: binary alpha, palette, frame dimensions verified')
