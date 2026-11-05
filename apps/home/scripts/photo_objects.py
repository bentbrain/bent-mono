"""Original simplified geometry reconstructed from the user's September room photos."""
import math,json
import room_details
from mathutils import Vector,Matrix

def specs(root):
 return [{'category':'Furniture','placement':'floor','defaultElevation':0,'purchased':False,'approximate':True,'detail':'Scene model','source':'Scene model','url':'','finishes':[],**p} for p in json.loads((root/'data/photo-objects.json').read_text())]

def clock_morphs(obj,height_scale):
 obj.shape_key_add(name='Basis')
 tail=set();eyes=set()
 for face in obj.data.polygons:
  material=obj.data.materials[face.material_index].name
  if material.startswith('clock-tail'):tail.update(face.vertices)
  if material.startswith('clock-pupils'):eyes.update(face.vertices)
 inverse=obj.matrix_world.inverted();pivot=Vector((0,0,.18*height_scale))
 for name,sign in [('clock-left',-1),('clock-right',1)]:
  key=obj.shape_key_add(name=name)
  for i in tail:
   p=obj.matrix_world@key.data[i].co;delta=p-pivot;a=sign*.23
   p.x=pivot.x+delta.x*math.cos(a)+delta.z*math.sin(a);p.z=pivot.z-delta.x*math.sin(a)+delta.z*math.cos(a)
   key.data[i].co=inverse@p
  for i in eyes:
   p=obj.matrix_world@key.data[i].co;p.x+=sign*.006;key.data[i].co=inverse@p

def build(spec, *, box,cylinder,cone,sphere,mesh,tube,lathe,ring,rr,cut,mat,parts):
 name=spec['id']
 if name in room_details.IDS:
  return room_details.build(spec,box=box,cylinder=cylinder,cone=cone,sphere=sphere,mesh=mesh,tube=tube,lathe=lathe,ring=ring,rr=rr,mat=mat,parts=parts)
 cream=mat('photo-cream','#e4dfce');white=mat('photo-white','#efeee6');black=mat('photo-black','#252b2c')
 orange=mat('photo-orange','#e77617');pink=mat('photo-pink','#c8a3ab');steel=mat('photo-steel','#adb9b7')
 green=mat('photo-leaf','#385538');wood=mat('photo-wood','#8d6748');blue=mat('photo-blue','#547d91')
 def smooth(o):
  for f in o.data.polygons:f.use_smooth=True
  return o
 def ball(p,s,m):return smooth(sphere(p,s,m))
 def turned(profile,m,label):return smooth(lathe(profile,m,64,label))
 def face_disc(x,y,z,r,depth,m):
  o=cylinder((x,y,z),r,depth,m,48);o.rotation_euler.x=math.pi/2;return o
 def frame(w,h):
  box((0,0,h/2),(w,.025,h),black,.003)
  box((0,.014,h/2),(w-.026,.005,h-.026),cream,.001)
 def book(x,y,z,w,d,h,color):
  m=mat('book-'+color,color);box((x,y,z+h/2),(w,d,h-.006),cream,.001)
  for dz in [0,h-.003]:box((x,y,z+dz+.0015),(w+.004,d+.004,.003),m,.001)
  box((x,y+d/2,z+h/2),(w,.007,h),m,.001)
  for dx in [-w*.3,w*.22]:box((x+dx,y+d/2+.004,z+h/2),(.025,.001,.003),cream,0)
 def leaf(start,angle,length,width,lift,index,leafmat=green):
  direction=Vector((math.cos(angle),math.sin(angle),lift));side=Vector((-math.sin(angle),math.cos(angle),0));origin=Vector(start)
  verts=[];rows=12
  for j in range(rows+1):
   t=j/rows;centre=origin+direction*length*t;centre.z+=.045*math.sin(t*math.pi)
   # Wavy broad violin shape with a slight waist, not a flat oval billboard.
   shape=math.sin(math.pi*t)**.62*(.83+.17*math.cos(t*math.tau*2))
   for k in [-1,0,1]:
    p=centre+side*k*width*shape/2;p.z+=abs(k)*(.009*math.sin(t*math.pi*5+index)-.016*shape);verts.append(tuple(p))
  o=mesh('Fiddle leaf '+str(index),verts,[(j*3+k,j*3+k+1,(j+1)*3+k+1,(j+1)*3+k) for j in range(rows) for k in range(2)],leafmat)
  sol=o.modifiers.new('Leaf thickness','SOLIDIFY');sol.thickness=.0015
  vein=mat('photo-leaf-vein','#829164');tube([verts[j*3+1] for j in range(rows+1)],.0015,vein)
  for j in [3,5,7,9]:
   for k in [0,2]:tube([verts[(j-2)*3+1],verts[j*3+k]],.0008,vein)
  return o
 if name=='ikornnes':
  ash=mat('finish-primary','#b99363');silver=mat('mirror-silver','#b9ced0')
  outer=rr(.52,1.67,.075);inner=rr(.487,1.637,.059)
  start=len(parts)
  ring(outer,inner,-.014,.014,ash,'Ash bentwood frame')
  mesh('Mirror glass',[(x,y,-.0145) for x,y in inner],[tuple(range(len(inner)-1,-1,-1))],silver)
  mesh('Mirror backing',[(x,y,.012) for x,y in inner],[tuple(range(len(inner)))],mat('mirror-back','#8b7559'))
  transform=Matrix.Rotation(math.pi/2,4,'X')
  lean=Matrix.Rotation(math.radians(6),4,'X')
  for o in parts[start:]:o.matrix_world=lean@Matrix.Translation((0,0,.835))@transform@o.matrix_world
 elif name=='fiddle-leaf':
  turned([(0,0),(.13,0),(.151,.024),(.16,.25),(.168,.263),(.168,.275),(.153,.275),(.146,.252),(0,.248)],black,'Black nursery pot')
  cylinder((0,0,.255),.145,.008,mat('photo-soil','#342a20'),48)
  tube([(0,0,.255),(-.015,.02,.75),(.022,-.015,1.3),(.005,0,1.92)],.013,wood)
  tube([(0,0,.48),(.11,.045,1),(.15,.06,1.58)],.009,wood)
  for i in range(27):
   z=.37+i*.060;a=i*2.399;start=(.02*math.sin(i),.015*math.cos(i),z)
   tip=(start[0]+.055*math.cos(a),start[1]+.055*math.sin(a),z+.045)
   tube([start,tip],.003,wood)
   leaf(tip,a,.31,.27,.45+(i%4)*.25,i,green if i%3 else mat('photo-leaf-light','#4e6945'))
 elif name=='plant-trolley':
  for x in [-.15,.15]:
   for y in [-.15,.15]:ball((x,y,.025),(.025,.018,.025),black)
  shell=ring(rr(.42,.42,.065),rr(.39,.39,.05),.045,.32,orange,'Orange open trolley')
  cut(shell,box((0,.20,.175),(.31,.10,.19),black,.028,8))
  box((0,0,.06),(.39,.39,.025),orange,.015);box((0,0,.303),(.39,.39,.015),orange,.012)
  box((0,-.187,.175),(.31,.006,.19),mat('trolley-interior','#a64512'),.005)
 elif name=='hang-it-all':
  colors=['#272c2d','#d05c8b','#dc672c','#164b43','#e4bf28','#573853','#34583d','#315e87']
  for z in [.095,.225]:tube([(-.21,0,z),(.21,0,z)],.0045,white)
  for x in [-.21,.21]:tube([(x,0,.095),(x,0,.225)],.0045,white)
  for i,x in enumerate([-.20,-.067,.067,.20]):
   tube([(x,0,.225),(x-.018,.08,.285),(x-.018,.08,.343)],.0045,white)
   ball((x-.018,.08,.345),(.026,.026,.026),mat('hook-top-'+str(i),colors[i]))
  for i,x in enumerate([-.24,-.145,-.048,.048,.145,.24]):
   z=.20 if i in [0,5] else .10;tube([(x*.8,0,.19),(x,.075,z)],.004,white)
   ball((x,.075,z),(.020,.020,.020),mat('hook-small-'+str(i),colors[(i+4)%8]))
  for i,x in enumerate([-.17,-.055,.055,.17]):
   tube([(x,0,.11),(x,.14,.04)],.004,white);ball((x,.14,.04),(.024,.024,.024),mat('hook-bottom-'+str(i),colors[(i+2)%8]))
 elif name=='orange-cat-clock':
  # Moving parts use unique materials so their semantic names survive glTF joining.
  tailmat=mat('clock-tail','#e77617');pupil=mat('clock-pupils','#171d1e')
  tail=ball((.012,0,.092),(.017,.012,.092),tailmat);tail.name='clock-tail'
  box((0,0,.247),(.125,.055,.135),orange,.022,8)
  ball((0,0,.363),(.073,.034,.059),orange)
  for x in [-.05,.05]:
   cone((x,0,.409),.026,.003,.043,orange,3)
   ball((x*.53,.033,.373),(.024,.009,.025),white)
   ball((x*.53,.042,.373),(.007,.003,.019),pupil)
   for dx in [-.01,0,.01]:tube([(x*.53+dx,.035,.391),(x*.53+dx*1.25,.035,.405)],.0015,black)
   ball((x*.46,.034,.340),(.023,.009,.01),cream)
   for j in range(3):tube([(x*.35,.042,.343+j*.004),(x*.75,.043,.341+j*.008)],.001,cream)
   ball((x,.028,.187),(.018,.015,.012),orange)
  ball((0,.044,.35),(.009,.005,.005),black)
  for i in range(10):ball((-.05+i*.011,.031,.307),(.005,.005,.005),cream)
  dial=face_disc(0,.029,.246,.046,.004,cream)
  face_disc(0,.032,.246,.042,.004,mat('clock-face','#d58a50'))
  for i in range(12):
   a=i*math.tau/12;ball((.035*math.sin(a),.037,.246+.035*math.cos(a)),(.002,.001,.0028),white)
  tube([(0,.040,.246),(0,.040,.277)],.0018,mat('clock-minute','#eee8cf'))
  tube([(0,.041,.246),(.020,.041,.256)],.0025,mat('clock-hour','#eee8cf'))
  ball((0,.043,.246),(.004,.002,.004),cream)
 elif name in ['forest-frame','dark-poster-frame']:
  w,h=spec['w'],spec['h'];frame(w,h)
  if name=='forest-frame':
   box((0,.018,h/2),(w-.034,.003,h-.034),mat('print-sky','#9aaeb4'),0)
   mesh('Blue distant mountains',[(.0,.021,.02),(.17,.021,.02),(.17,.021,.16),(.09,.021,.22),(-.04,.021,.10)],[(0,1,2,3,4)],blue)
   for i in range(17):
    x=-.15+(i%4)*.038;z=.04+(i//4)*.064
    ball((x,.024,z),(.040,.002,.043),green if i%2 else mat('print-olive','#727b4b'))
   for i in range(4):
    x=-.14+i*.041;tube([(x,.03,.025),(x+.014,.03,.20),(x+.052,.03,.32)],.004,cream)
    tube([(x+.01,.03,.14),(x-.016,.03,.24)],.0025,cream)
   for x,z in [(.10,.30),(.13,.26)]:tube([(x-.012,.024,z+.004),(x,.024,z),(x+.012,.024,z+.005)],.001,black)
  else:
   box((0,.018,h/2),(w-.046,.003,h-.046),mat('poster-charcoal','#252b2b'),0)
   ball((.035,.021,.43),(.18,.001,.25),mat('poster-figure','#303634'))
   box((-.17,.022,.08),(.10,.002,.07),mat('poster-teal','#397b7c'),0)
 elif name=='lighthouse-lamp':
  navy=mat('lighthouse-blue','#354d59');red=mat('lighthouse-red','#a44835');gold=mat('lighthouse-brass','#b9a76b')
  turned([(0,0),(.094,0),(.10,.008),(.10,.023),(.083,.029),(0,.029)],navy,'Blue lighthouse foot')
  turned([(0,.025),(.080,.025),(.05,.39),(.066,.417),(0,.417)],cream,'Cream tapered tower')
  box((0,.077,.063),(.024,.004,.057),red,.002)
  for x,y,z in [(0,.061,.30),(-.06,0,.18)]:box((x,y,z),(.014,.004,.025),navy,.001)
  cylinder((0,0,.422),.082,.012,gold,64)
  for z in [.428,.463]:turned([(.079,z),(.082,z+.003),(.079,z+.005)],gold,'Balcony railing')
  for i in range(12):
   a=i*math.tau/12;cylinder((.078*math.cos(a),.078*math.sin(a),.447),.002,.035,gold,8)
  cylinder((0,0,.501),.055,.085,mat('lighthouse-diffuser','#f3efdc'),64)
  for z in [.46,.50,.543]:turned([(.055,z),(.058,z+.002),(.055,z+.004)],gold,'Lantern horizontal frame')
  for i in range(8):
   a=i*math.tau/8;cylinder((.055*math.cos(a),.055*math.sin(a),.503),.002,.08,gold,8)
  turned([(0,.593),(.018,.588),(.039,.575),(.058,.552),(.061,.542),(0,.542)],red,'Red domed roof')
  ball((0,0,.598),(.006,.006,.006),red)
 elif name=='ceramic-pig':
  glaze=mat('pig-glaze','#d4c2c5');patch=mat('pig-rose','#bda0ac');snout=mat('pig-snout','#b37b64')
  ball((0,-.025,.163),(.071,.081,.093),glaze);ball((0,.041,.246),(.065,.054,.060),glaze)
  for x in [-.059,.059]:
   o=ball((x,.018,.292),(.038,.018,.049),glaze);o.rotation_euler.y=-.45 if x<0 else .45
   ball((x,.034,.292),(.027,.005,.033),pink)
  ball((0,.093,.232),(.035,.015,.03),snout)
  for x in [-.012,.012]:ball((x,.106,.234),(.006,.003,.007),black)
  for x in [-.034,.034]:ball((x,.082,.263),(.007,.004,.008),black);ball((x-.001,.085,.266),(.002,.001,.002),white)
  for x in [-.046,.046]:
   for y in [-.055,.04]:
    tube([(x*1.2,y,.012),(x,y*.7,.13)],.012,glaze);ball((x*1.2,y,.013),(.017,.021,.012),cream)
  tube([(0,-.10,.18),(.025,-.115,.19),(.037,-.105,.209),(.018,-.108,.215)],.006,glaze)
  for i in range(9):
   a=i*2.4;ball((.065*math.sin(a),-.025+.077*math.cos(a),.13+(i%3)*.035),(.015,.007,.019),patch)
 elif name=='sideboard-tablet':
  box((0,0,.005),(.25,.18,.010),steel,.008,6);box((0,0,.011),(.234,.164,.002),mat('tablet-screen','#202938'),.005,4)
 elif name=='pastel-catchalls':
  for x,h,m in [(-.07,.24,cream),(.07,.20,mat('vessel-blue','#a5c7cc'))]:
   ring(rr(.12,.13,.008),rr(.11,.12,.006),.004,h,m,'Open pastel vessel');box((x,0,.005),(.11,.12,.01),m)
   # Move only the newly-created rim; the bottom already uses the correct x.
   parts[-2].location.x=x
  ball((.065,0,.19),(.039,.033,.036),pink)
 elif name=='black-ink-pot':
  box((0,0,.027),(.072,.07,.054),black,.008);ball((0,0,.052),(.029,.026,.009),cream)
  turned([(.009,.055),(.012,.055),(.013,.069),(.012,.077),(.006,.077),(.006,.063)],black,'Ink pot neck')
 elif name=='sideboard-papers':
  for x,y,w,d in [(-.04,0,.17,.13),(-.07,.068,.14,.047)]:
   box((x,y,.003),(w,d,.002),cream,0)
   for i in range(6):box((x-w*.35+i*w*.13,y,.004),(.010,d*.65,.001),black,0)
  box((.117,0,.010),(.028,.19,.015),wood,.002)
  box((.117,0,.018),(.005,.155,.001),black,0)
 elif name=='shelf-plant':
  turned([(0,0),(.06,0),(.072,.115),(.074,.13),(.064,.13),(.06,.115),(0,.11)],white,'Blue patterned plant pot')
  cylinder((0,0,.12),.063,.005,wood,32)
  for i in range(24):
   a=i*2.399;z=.025+(i%4)*.025;ball((.069*math.cos(a),.069*math.sin(a),z),(.008,.006,.01),blue)
  for i in range(10):
   a=i*2.399;z=.15+i*.019;start=(0,0,z);tube([(0,0,.12),start],.002,green)
   leaf(start,a,.10,.055,.4,i,pink if i%3==0 else green)
 elif name=='amber-glassware':
  amber=mat('amber-glass','#c68e35')
  bottle=turned([(0,0),(.046,0),(.05,.008),(.05,.13),(.044,.151),(.025,.165),(.022,.22),(.022,.23),(.016,.23),(.016,.17),(0,.145)],amber,'Amber bottle')
  turned([(.035,0),(.04,.003),(.042,.09),(.037,.09),(.033,.007),(.035,0)],amber,'Amber tumbler').location.x=.105
  turned([(.025,0),(.036,.01),(.04,.027),(.033,.05),(.027,.05),(.034,.026),(.027,.009),(.025,0)],mat('votive-glass','#dbbd88'),'Small votive').location.x=-.09
 elif name in ['book-stack-pale','book-stack-colour','large-art-book']:
  colors=['#282d32','#f2ead8','#eee8df','#e2dfd3'] if name=='book-stack-pale' else ['#dc593c','#e5c249','#333e4c','#ddc6aa','#b5413c','#cdd54c','#396a86']
  if name=='large-art-book':colors=['#dddccf']
  for i,c in enumerate(colors):book((i%2)*.005,0,i*spec['h']/len(colors),spec['w']-.01,spec['d']-.01,spec['h']/len(colors),c)
  if name=='large-art-book':
   for i in range(7):box((-.14+i*.045,0,.041),(.018,.16,.002),black,0)
 elif name=='orange-shelf-cubby':
  shell=ring(rr(.40,.26,.035),rr(.373,.233,.027),0,.29,orange,'Open orange shelf box')
  cut(shell,box((0,.13,.151),(.335,.12,.224),black,.024,8));box((0,0,.01),(.37,.23,.02),orange,.012)
  for i in range(4):box((.005*(i%2),0,.045+i*.045),(.32,.21,.04),black,.016,5)
  box((.035,0,.256),(.30,.21,.049),black,.019,5)
 elif name=='eagle-display-plate':
  plate=face_disc(0,0,.099,.085,.006,blue)
  face_disc(0,.004,.099,.076,.002,mat('plate-sky','#9db8d1'))
  for side in [-1,1]:
   mesh('Eagle wing',[(0,.007,.11),(side*.065,.007,.157),(side*.03,.007,.10),(0,.007,.068)],[(0,1,2,3)],black)
   tube([(side*.045,.03,0),(side*.04,-.025,.045),(side*.025,-.025,.10)],.003,black)
  ball((0,.008,.10),(.012,.004,.035),black);ball((.007,.011,.126),(.013,.003,.010),white)
 elif name=='shelf-figurines':
  # Four separately recognizable ornaments, grouped at their photographed spacing.
  for x in [-.23,.02,.24]:
   if x==-.23:
    cylinder((x,0,.012),.035,.02,mat('figure-plinth','#714234'),32)
    box((x,0,.11),(.047,.032,.069),mat('figure-jacket','#694e42'),.012)
    for dx in [-.015,.015]:tube([(x+dx,0,.02),(x+dx,0,.087)],.009,black)
    ball((x,0,.183),(.037,.030,.043),mat('figure-skin','#bd9c78'));ball((x,-.006,.212),(.038,.031,.016),mat('figure-hair','#96988e'))
    for dx in [-.017,.017]:box((x+dx,.029,.187),(.026,.005,.018),black,.004)
    tube([(x-.034,0,.13),(x-.04,.034,.094),(x+.018,.025,.095)],.009,cream)
   elif x==.02:
    ball((x,0,.092),(.028,.025,.03),mat('toy-globe','#548e9c'))
    for a in range(5):ball((x+.018*math.sin(a*2),.023,.09+a*.004),(.009,.002,.007),green)
    ball((x,0,.046),(.018,.016,.032),pink)
    for dx in [-.015,.015]:tube([(x+dx,0,.041),(x+dx*1.7,.013,.009)],.007,pink)
   else:
    skin=mat('action-figure-skin','#584539');pants=mat('action-figure-pants','#8c7b54')
    ball((x,-.015,.145),(.030,.022,.05),skin);ball((x,-.01,.211),(.019,.018,.027),skin)
    for dx in [-.02,.02]:
     tube([(x+dx,0,.116),(x+dx,.038,.087),(x+dx,.075,.009)],.014,pants)
     tube([(x+dx*1.7,-.005,.172),(x+dx*2.2,.02,.124),(x+dx*1.9,.05,.11)],.009,skin)
  ball((.10,.035,.015),(.035,.013,.012),pink)
  for i in range(4):tube([(.13,.021+i*.008,.016),(.153,.022+i*.008,.014)],.003,pink)
 elif name=='jewellery-tray':
  box((-.11,0,.005),(.19,.19,.01),white,.003)
  for a in [0,math.pi/4]:
   o=box((-.11,0,.014),(.15,.014,.012),cream,.002);o.rotation_euler.z=a
  o=turned([(0,0),(.075,0),(.085,.006),(.087,.014),(.079,.018),(.067,.009),(0,.008)],steel,'Silver jewellery dish');o.location.x=.13;o.scale.y=.6
  for i in range(7):ball((.11+.03*math.cos(i),.022*math.sin(i),.018),(.009,.006,.004),steel)
 elif name=='shelf-shoes':
  schemes=[('#d6d2c9','#a74036'),('#474743','#363b38'),('#67568b','#63814b'),('#d2cdbf','#b3b4aa'),('#d4c7bf','#242c31'),('#d5d6c9','#354e5f')]
  for pair,(main,trim) in enumerate(schemes):
   for foot in [-1,1]:
    x=-.635+pair*.255+foot*.049;m=mat('shoe-'+main,main);t=mat('shoe-trim-'+trim,trim)
    box((x,0,.017),(.087,.258,.030),cream,.018,5)
    ball((x,.025,.050),(.041,.122,.04),m);box((x,-.067,.092),(.079,.080,.11),t,.018,5)
    ball((x,-.067,.144),(.029,.029,.004),black)
    for i in range(4):tube([(x-.025,.006+i*.014,.083-i*.004),(x+.025,.006+i*.014,.083-i*.004)],.002,pink if pair==4 else cream)
 else:raise ValueError(name)
