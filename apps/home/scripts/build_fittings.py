"""Photograph-derived fixed fittings. Four true orthographic Blender renders each."""
import sys, pathlib, math, json, os
os.environ['APARTMENT_ASSET_PALETTE']='apartment-fixtures-v2'
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build_models as m
import bpy
from mathutils import Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view
# World Z is screen-depth, while Blender Z is height. Preserve handedness explicitly.
world_to_blender=Matrix.Diagonal((1,-1,60.72/(48*math.sqrt(1.5)),1))
m.camera.location=(8,-8,8*math.sqrt(2/3))
m.camera.rotation_euler=(-m.camera.location).to_track_quat('-Z','Y').to_euler()

cube, cyl, ell = m.cube, m.cyl, m.ell
m.ramps.update(wood=['#8e694d','#ac805d','#dcc5a9'],white=['#c7c8be','#f6f5ee','#ffffff'],grey=['#4e5656','#89908b','#d9ddd4'],dark=['#303635','#343b39','#4e5656'],charcoal=['#303635','#4b514f','#626865'],green=['#798889','#a8d6dd','#d2ece8'])
# Front faces negative Y, matching the existing canonical north convention.
SPECS = {
 'kitchen-run': (4.2, .62, 2.7, 'Fitted kitchen with stainless benchtop'),
 'kitchen-overheads': (2.5, .34, 2.3, 'Timber overhead cupboards and rangehood'),
 'kitchen-tall': (1.2, .62, 2.7, 'Integrated fridge / pantry'),
 'bedroom-robe': (2.65, .6, 2.4, 'Enclosed bedroom wardrobe'),
 'kitchen-base': (.6, .62, .91, 'Kitchen base cupboard'),
 'kitchen-oven': (.6, .62, .95, 'Gas hob and oven'),
 'kitchen-dishwasher': (.6, .62, .91, 'Dishwasher'),
 'kitchen-sink': (1.2, .62, 1.19, 'Double sink and drawers'),
 'kitchen-upper': (.6, .34, 2.3, 'Timber overhead cupboard'),
 'kitchen-hood': (.6, .34, 2.3, 'Overhead cupboard and rangehood'),
 'bath-vanity': (.85, .52, 1.13, 'Floating timber vanity'),
 'bath-mirror': (.85, .17, 2.13, 'Mirror cupboard and open shelves'),
 'bath-toilet': (.4, .68, .86, 'Toilet'),
 'bath-shower': (.84, 1.53, 2.16, 'Frameless shower'),
 'laundry-sink': (.55, .5, 1.16, 'Laundry utility sink'),
}

def pipe(a, b, radius=.015):
 from mathutils import Vector
 va,vb=Vector(a),Vector(b); delta=vb-va
 o=cyl((va+vb)/2,radius,delta.length,'grey',8)
 o.rotation_euler=delta.to_track_quat('Z','Y').to_euler()
 return o

def tap(x=0,y=.18,z=.93):
 pipe((x,y,z),(x,y,z+.23),.022)['faucet_stem']=True
 pipe((x,y,z+.21),(x,y-.16,z+.21),.017)
 pipe((x+.018,y,z+.14),(x+.085,y,z+.18),.01)

def basin(x,y,z,w,d,material='white'):
 # Stainless bowls descend from a 4 mm lip flush with the benchtop.
 if material=='grey':
  for sx in [-1,1]:
   o=cube((x+sx*(w/2-.012),y,z-.076),(.024,d,.16),'grey');o['sink_rim']=True
  for sy in [-1,1]:
   o=cube((x,y+sy*(d/2-.012),z-.076),(w,.024,.16),'grey');o['sink_rim']=True
  cube((x,y,z-.155),(w-.035,d-.035,.012),'grey')
  cyl((x,y,z-.145),.022,.004,'dark',8)
  return
 cube((x,y,z-.085),(w-.04,d-.04,.025),'grey' if material=='grey' else 'white')
 for sx in [-1,1]:cube((x+sx*(w/2-.025),y,z-.02),(.05,d,.14),material)
 for sy in [-1,1]:cube((x,y+sy*(d/2-.025),z-.02),(w,.05,.14),material)
 cyl((x,y,z-.067),.025,.005,'dark',8)

def base(w=.6,recessed=False):
 cube((0,.015,.065),(w-.04,.54,.13),'dark')
 cube((0,0,.405 if recessed else .49),(w-.014,.6,.59 if recessed else .76),'charcoal')
 return cube((0,0,.895),(w,.62,.03),'grey')

def front(w,z,h,material='charcoal'):
 cube((0,-.306,z),(w-.026,.022,h),material)

def timber_grain(w,y,lo,hi):
 for i in range(1,max(2,round(w/.12))):
  x=-w/2+i*.12
  cube((x,y,(lo+hi)/2),(.008,.005,(hi-lo)*(.7 if i%2 else .9)),'wood')

def fitting(name):
 if name in ['kitchen-run','kitchen-overheads']:
  parts=[('kitchen-tall',-1.5,1),('kitchen-sink',-.3,1),('kitchen-dishwasher',.6,1),('kitchen-oven',1.2,1),('kitchen-base',1.8,1)] if name=='kitchen-run' else [('kitchen-hood' if i==3 else 'kitchen-upper',dx,.35/.6 if i<2 else 1) for i,dx in enumerate([-1.075,-.725,-.25,.35,.95])]
  for part,dx,scale in parts:
   start=len(m.objects);fitting(part)
   for o in m.objects[start:]:
    o.location.x=o.location.x*scale+dx;o.scale.x*=scale
 elif name=='kitchen-tall':
  cube((0,0,1.35),(1.2,.62,2.7),'charcoal')
  # As seen facing the kitchen: narrow pantry on the left, wide fridge on the right.
  for label,x,w,handle in [('fridge',-.175,.85,.15),('pantry',.425,.35,.35)]:
   door=cube((x,-.322,1.045),(w-.014,.022,1.96),'charcoal');door['door_role']=label
   cube((handle,-.343,.96),(.10,.033,.018),'white')
   cube((x,-.322,2.37),(w-.014,.022,.64),'charcoal')
  cube((0,-.322,.045),(1.18,.014,.075),'dark')
  cube((.25,-.337,1.4),(.022,.009,2.58),'dark')
 elif name=='bedroom-robe':
  cube((0,0,1.2),(2.65,.6,2.4),'charcoal')
  for i in range(4):
   x=-2.65/2+(i+.5)*2.65/4
   cube((x,-.31,1.22),(2.65/4-.015,.02,2.34),'charcoal')
  for x in [-.70,-.625,.625,.70]:
   o=cyl((x,-.333,1.05),.025,.022,'grey',12);o.rotation_euler.x=math.pi/2
  cube((0,-.311,.04),(2.61,.024,.07),'dark')
 elif name in ['kitchen-base','kitchen-oven','kitchen-dishwasher','kitchen-sink']:
  w=1.2 if name=='kitchen-sink' else .6
  top=base(w,name=='kitchen-sink')
  if name=='kitchen-base':front(w,.48,.70)
  if name=='kitchen-dishwasher':
   front(w,.43,.62);front(w,.805,.11,'grey')
   cube((0,-.333,.817),(.18,.015,.024),'dark')
   cyl((.21,-.342,.8),.019,.008,'grey').rotation_euler.x=math.pi/2
  if name=='kitchen-oven':
   front(w,.47,.73,'grey');front(w,.44,.48,'dark')
   cube((0,-.326,.43),(.43,.015,.27),'grey')
   cube((0,-.35,.66),(.43,.035,.026),'white')
   for x in [-.17,.17]:
    o=cyl((x,-.34,.78),.028,.015,'grey');o.rotation_euler.x=math.pi/2
   cube((0,-.33,.78),(.10,.012,.033),'dark')
   cube((0,0,.922),(.52,.48,.014),'grey')
   for x in [-.15,.15]:
    for y in [-.14,.14]:
     cyl((x,y,.944),.065,.013,'dark')
     cube((x,y,.95),(.19,.021,.017),'dark');cube((x,y,.95),(.021,.19,.017),'dark')
  if name=='kitchen-sink':
   for z,h in [(.735,.22),(.485,.24),(.205,.29)]:front(w,z,h)
   # Replace the worktop with strips around two recessed stainless bowls.
   m.objects.remove(top);bpy.data.objects.remove(top,do_unlink=True)
   cube((0,.245,.895),(w,.13,.03),'grey');cube((0,-.25,.895),(w,.12,.03),'grey')
   cube((-.48,-.005,.895),(.24,.37,.03),'grey');cube((.565,-.005,.895),(.07,.37,.03),'grey')
   for x in [-.14,.30]:basin(x,-.01,.91,.44,.39,'grey')
   for x in [-.55,-.49,-.43]:cube((x,0,.916),(.012,.26,.008),'white')
   tap(.08,.24,.94)
 elif name in ['kitchen-upper','kitchen-hood']:
  cube((0,0,1.96),(.6,.34,.68),'wood')
  cube((0,-.178,1.97),(.58,.016,.65),'wood');timber_grain(.6,-.189,1.7,2.24)
  cube((0,-.02,1.59),(.6,.28,.035),'white')
  if name=='kitchen-hood':
   cube((0,-.04,1.60),(.48,.27,.075),'grey')
   cube((0,-.08,1.557),(.34,.14,.008),'dark')
 elif name=='bath-vanity':
  cube((0,0,.495),(.83,.5,.47),'wood')
  for z in [.385,.65]:cube((0,-.257,z),(.815,.018,.24),'wood')
  timber_grain(.8,-.27,.31,.72)
  basin(0,0,.84,.85,.52);tap(-.105,.17,.84)
 elif name=='bath-mirror':
  cube((0,0,1.67),(.85,.13,.92),'white')
  cube((-.105,-.075,1.69),(.62,.015,.84),'dark')
  cube((-.105,-.09,1.69),(.57,.012,.79),'green')['mirror_glass']=True
  # Compact diagonal reflection, no reflected furniture invented.
  o=cube((-.14,-.10,1.76),(.03,.01,.51),'white');o.rotation_euler.y=-.48
  for z in [1.25,1.51,1.78,2.08]:cube((.32,-.025,z),(.2,.16,.023),'white')['open_shelf']=True
  cube((0,-.04,1.2),(.85,.17,.035),'wood')
 elif name=='bath-toilet':
  cube((0,.225,.58),(.38,.19,.50),'white',.035)
  cube((0,.225,.837),(.39,.20,.025),'white',.012)
  cyl((0,.225,.856),.032,.008,'grey')
  ell((0,-.07,.29),(.15,.22,.25),'white')
  ell((0,-.085,.445),(.2,.28,.07),'white')
  ell((0,-.1,.49),(.185,.25,.022),'white')
 elif name=='bath-shower':
  # Coordinates match the east-end enclosure. Glass is mostly transparent pixels.
  cube((0,0,.012),(.84,1.53,.024),'charcoal')
  for x in [-.28,0,.28]:cube((x,0,.026),(.012,1.51,.008),'dark')
  for y in [-.6,-.3,0,.3,.6]:cube((0,y,.026),(.82,.012,.008),'dark')
  cube((.1,-.3,.036),(.105,.105,.01),'white')
  for v in [-.025,.025]:cube((.1+v,-.3,.043),(.012,.08,.008),'dark')
  # Closed west glass screen and door span the full enclosure.
  for y in [-.75,-.05,.75]:pipe((-.40,y,.055),(-.40,y,2.12),.007)
  pane=cube((-.40,0,1.087),(.008,1.50,2.065),'green');pane['shower_glass']=True
  pipe((-.40,-.75,2.12),(-.40,.75,2.12),.007)
  for y in [.10,.18]:pipe((-.398,y,1.15),(-.398,y+.20,1.47),.009)
  pipe((-.4,.58,1.05),(-.4,.58,1.24),.012)
  pipe((.25,.72,1.2),(.25,.72,2.09),.018)
  pipe((.25,.72,2.09),(.25,.34,2.09),.018)
  cyl((.25,.34,2.07),.10,.035,'grey',16)
  pipe((.25,.715,1.16),(.25,.65,1.16),.04)
 elif name=='laundry-sink':
  cube((0,0,.35),(.53,.48,.7),'white')
  basin(0,0,.86,.55,.5,'grey');tap(0,.20,.91)
  cube((0,-.25,.55),(.15,.025,.018),'grey')
 else:raise ValueError(name)

if __name__ == '__main__':
 for name,(w,d,h,label) in SPECS.items():
  if name.startswith('kitchen-') and name not in ['kitchen-run','kitchen-overheads']:continue
  requested=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
  if requested and name not in requested:continue
  size=480 if name.startswith(('kitchen-','bedroom-')) else 240
  m.scene.render.resolution_x=size;m.scene.render.resolution_y=size;m.camera.data.ortho_scale=size/(48*math.sqrt(2))
  bpy.context.view_layer.update()
  for quarter in range(4):
   t=quarter*math.pi/2;x,z=math.cos(t),math.sin(t)
   pixel=world_to_camera_view(m.scene,m.camera,Vector((x,-z,0)))
   assert abs(pixel.x*size-(size/2+(x-z)*48))<.05
   assert abs((1-pixel.y)*size-(size*.75+(x+z)*24))<.05,(size,quarter,pixel[:],(1-pixel.y)*size,size*.75+(x+z)*24)
  work=m.ROOT/'runs/furniture'/name;work.mkdir(parents=True,exist_ok=True)
  (work/'request.json').write_text(json.dumps({'id':name,'name':label,'dimensionsMetres':{'width':w,'depth':d,'height':h},'footprint':{'width':math.ceil(w/.25),'depth':math.ceil(d/.25)},'materials':['timber','charcoal laminate','stainless steel','white ceramic','clear glass'],'palette':'apartment-fixtures-v2','frameSize':size,'paletteRamps':m.ramps,'asymmetry':'Front appliances and handles; north-facing fronts. Shower has a west screen and south showerhead.','references':['runs/property-reference/floorplan.webp','runs/property-reference/listing-03.jpg','runs/property-reference/listing-07.jpg'],'accuracy':'Photo-derived appearance; dimensions estimated. Laundry basin appearance inferred from floorplan.'},indent=2)+'\n')
  for q,direction in enumerate(['north','east','south','west']):
   for o in m.objects:bpy.data.objects.remove(o,do_unlink=True)
   m.objects.clear();fitting(name)
   for o in m.objects:
    t=q*math.pi/2;x,y=o.location.x,o.location.y;o.location.x=x*math.cos(t)-y*math.sin(t);o.location.y=x*math.sin(t)+y*math.cos(t);o.rotation_euler.z+=t
   bpy.context.view_layer.update()
   for o in m.objects:o.matrix_world=world_to_blender@o.matrix_world
   bpy.context.view_layer.update()
   for o in m.objects:
    for color in m.ramps[o['ramp']]:o.data.materials.append(m.mats[color])
    for face in o.data.polygons:
     n=o.matrix_world.to_3x3().inverted().transposed()@face.normal;face.material_index=2 if n.z>.5 else (1 if n.y<-.1 else 0)
   bpy.context.view_layer.update()
   m.scene.render.filepath=str(work/f'{name}-idle-{direction}.png');bpy.ops.render.render(write_still=True)
   if q==0:bpy.ops.wm.save_as_mainfile(filepath=str(work/f'{name}.blend'))
 print('FIXED FITTINGS RENDERED')
