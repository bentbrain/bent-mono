from pathlib import Path
from PIL import Image,ImageDraw
root=Path(__file__).resolve().parents[1]
for pet in ['pearl','maree']:
 work=root/'runs/characters'/(pet+'-v3');frames=[]
 for frame in range(8):
  sheet=Image.new('RGB',(454,672),'#86d4e8');draw=ImageDraw.Draw(sheet)
  for row,anim in enumerate(['idle','walk','sit','sleep','groom','jump','crouch']):
   draw.text((2,row*96+3),anim,fill='#303635')
   for col,d in enumerate(['north','east','south','west']):
    im=Image.open(work/f'{pet}-v3-{anim}-{d}.png').crop((frame*96,0,(frame+1)*96,96))
    sheet.paste(im,(70+col*96,row*96),im)
  frames.append(sheet)
 frames[0].save(work/'motion-native.gif',save_all=True,append_images=frames[1:],duration=120,loop=0)
 frames=[im.resize((1362,2016),Image.Resampling.NEAREST) for im in frames]
 frames[0].save(work/'motion.gif',save_all=True,append_images=frames[1:],duration=120,loop=0)
 frames[0].save(work/'poses-review.png')
