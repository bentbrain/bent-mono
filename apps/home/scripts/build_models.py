"""Original Blender models. Four orthographic views, no rotated raster artwork."""
import bpy, math, pathlib, json, os
from mathutils import Vector
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'runs/assets'; OUT.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine='CYCLES'; scene.cycles.samples=1
scene.render.resolution_x=240; scene.render.resolution_y=240; scene.render.resolution_percentage=100
scene.render.film_transparent=True
scene.view_settings.view_transform='Standard'; scene.view_settings.look='None'
scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGBA'
scene.world.color=(0,0,0)
colors=json.loads((ROOT/'assets/palettes'/f"{os.environ.get('APARTMENT_ASSET_PALETTE', 'apartment-hotel-v1')}.json").read_text())['colors']
mats={}
for color in colors:
 m=bpy.data.materials.new(color); m.use_nodes=True; n=m.node_tree.nodes; n.clear(); e=n.new('ShaderNodeEmission'); out=n.new('ShaderNodeOutputMaterial')
 rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]; e.inputs['Color'].default_value=tuple(((v+.055)/1.055)**2.4 if v>.04045 else v/12.92 for v in rgb)+(1,)
 m.node_tree.links.new(e.outputs[0],out.inputs[0]); mats[color]=m
ramps={'wood':['#8f5b45','#d6a36b','#ead39d'], 'white':['#ead39d','#fff5d6','#fffef3'], 'orange':['#8f3c55','#d85d73','#e4a46d'], 'dark':['#17121e','#251d2f','#4a3857'], 'grey':['#251d2f','#4a3857','#fff5d6'], 'green':['#277f7e','#52c7bd','#86d4e8']}
objects=[]
def cube(pos,size,material='wood',bevel=0):
 bpy.ops.mesh.primitive_cube_add(size=1,location=pos); o=bpy.context.object; o.scale=size; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 if bevel:
  mod=o.modifiers.new('Soft corners','BEVEL'); mod.width=bevel; mod.segments=1; bpy.ops.object.modifier_apply(modifier=mod.name)
 o['ramp']=material; objects.append(o); return o

def cyl(pos,radius,depth,material='dark',vertices=12):
 bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=pos);o=bpy.context.object;o['ramp']=material;objects.append(o);return o

def ell(pos,size,material='white'):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=6,radius=1,location=pos);o=bpy.context.object;o.scale=size;o['ramp']=material;objects.append(o);return o

def legs(w,d,h):
 for x in [-w/2,w/2]:
  for y in [-d/2,d/2]:cube((x,y,h/2),(.055,.055,h))

def model(name,anim='idle',frame=0):
 if name=='dyvlinge':
  cyl((0,0,.23),.035,.4)
  for a in range(5):
   t=a*math.tau/5; o=cube((math.cos(t)*.14,math.sin(t)*.14,.05),(.33,.035,.035),'grey');o.rotation_euler.z=t
  ell((0,.04,.4),(.315,.32,.13),'orange');ell((0,-.21,.55),(.315,.14,.16),'orange')
  for x in [-.17,0,.17]:cube((x,-.077,.57),(.014,.014,.11),'orange')
 elif name=='perjohan':
  legs(.85,.22,.44);cube((0,0,.435),(1,.25,.035));cube((0,0,.24),(.88,.22,.03));cube((0,-.12,.30),(.90,.025,.15));cube((0,.12,.30),(.90,.025,.15))
 elif name=='byakorre':
  for x in [-.62,0,.62]:cube((x,0,.81),(.035,.28,1.62),'dark')
  for z in [.12,.47,.82,1.17,1.62]:cube((0,0,z),(1.4,.32,.035),'white')
 elif name=='kirribilli':
  legs(1.4,1.8,.25);cube((0,0,.29),(1.56,2.12,.13),bevel=.04);cube((0,-1,.62),(1.56,.09,.68),bevel=.03)
  cube((0,.02,.46),(1.53,2.03,.22),'white',.04);cube((0,.38,.59),(1.51,1.22,.055),'green',.015)
  for x in [-.4,.4]:cube((x,-.70,.60),(.6,.4,.10),'white',.04)
 elif name=='okensand':
  # IKEA 805.415.27: 154 cm high, 48 cm base, 35 cm pleated shade.
  for a in range(3):
   t=a*math.tau/3
   foot=Vector((math.cos(t)*.222,math.sin(t)*.222,.014))
   shoulder=Vector((math.cos(t)*.115,math.sin(t)*.115,.40))
   o=cyl((foot+shoulder)/2,.017,(shoulder-foot).length,'wood',10)
   o.rotation_euler=(shoulder-foot).to_track_quat('Z','Y').to_euler();o.name=f'okensand-beech-leg-{a+1}'
  cyl((0,0,.35),.12,.018,'white',24).name='okensand-support'
  cyl((0,0,.91),.005,1.17,'white',8).name='okensand-spine'
  # Three candle-shaped E14 bulbs run vertically inside the diffuser.
  for i,h in enumerate([.52,.90,1.28]):
   cyl((0,0,h-.044),.010,.025,'white',10).name=f'okensand-e14-socket-{i+1}'
   bulb=ell((0,0,h),(.018,.018,.043),'white');bulb.name=f'okensand-e14-bulb-{i+1}';bulb['lamp_bulb']=i
  # Model actual pleats and the open top/bottom, not a solid cylindrical cap.
  pleats=32;count=pleats*2;bottom=.27;top=1.54
  for band in range(12):
   verts=[]
   for h in [bottom+(top-bottom)*band/12,bottom+(top-bottom)*(band+1)/12]:
    radius=.175-(h-bottom)/(top-bottom)*.066
    for i in range(count):
     t=i*math.tau/count;r=radius-(.005 if i%2 else 0)
     verts.append((r*math.cos(t),r*math.sin(t),h))
   mesh=bpy.data.meshes.new('pleated-diffuser');mesh.from_pydata(verts,[],[(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)]);mesh.update()
   o=bpy.data.objects.new(f'okensand-shade-band-{band:02}',mesh);bpy.context.collection.objects.link(o);o['ramp']='white';o['lamp_shade_band']=band;objects.append(o)
  cord=cube((0,-.16,.009),(.009,.15,.009),'white');cord.name='okensand-cord'
 elif name=='gullsudare':
  cyl((0,0,1.88),.012,.35,'white',8);ell((0,0,1.53),(.35,.35,.19),'white')
  for z in [1.43,1.50,1.57,1.64]:cyl((0,0,z),.31,.012,'white',16)
 elif name=='sofa':
  legs(1.8,.7,.16);cube((0,0,.33),(2.1,.9,.34),'green',.08);cube((0,-.36,.64),(2.1,.18,.6),'green',.06)
  for x in [-.96,.96]:cube((x,0,.55),(.22,.85,.38),'green',.04)
  for x in [-.44,.44]:cube((x,.05,.52),(.8,.65,.14),'green',.04)
 elif name=='table':
  legs(1.1,.65,.7);cube((0,0,.73),(1.3,.8,.07),'wood',.04)
 elif name=='vacuum':
  cyl((0,0,.055),.175,.11,'white',20);cyl((-.04,-.03,.13),.045,.045,'dark',12);cube((.04,.07,.115),(.04,.025,.01),'green')
 elif name in ['pearl','maree']:
  patch='grey' if name=='pearl' else 'dark';low=anim=='sleep'; sitting=anim in ['sit','groom']; z=.15 if low else .25
  ell((0,.01,z),(.13,.23,.11 if low else .14),'white');ell((-.015,.035,z+.08),(.13,.13,.075),patch)
  if name=='maree':ell((.09,-.07,z+.075),(.055,.1,.07),'orange')
  hy=-.18 if low else -.21;hz=.19 if low else .38
  if sitting:hz=.40;ell((0,.11,.19),(.14,.14,.19),'white')
  ell((0,hy,hz),(.145,.12,.12),'white');ell((-.085,hy+.01,hz+.06),(.067,.09,.073),patch)
  if name=='maree':ell((.085,hy+.01,hz+.06),(.065,.09,.07),'orange')
  for x in [-.095,.095]:
   bpy.ops.mesh.primitive_cone_add(vertices=4,radius1=.066,radius2=0,depth=.13,location=(x,hy,hz+.12));o=bpy.context.object;o['ramp']=patch if x<0 else 'white';objects.append(o)
   cube((x*.62,hy-.114,hz+.016),(.023,.018,.014 if low or (anim=='idle' and frame==1) else .033),'dark')
  cube((0,hy-.128,hz-.02),(.022,.018,.018),'orange')
  for i,(x,y) in enumerate([(-.085,-.14),(.085,-.14),(-.085,.16),(.085,.16)]):
   dz=.04 if anim=='walk' and (i+frame)%2 else 0
   if anim=='groom' and i==1:dz=.16+frame*.04
   cube((x,y,.075+dz),(.065,.075,.15),'white',.018)
  for i in range(5):
   cube((.015*(frame*2-1)*i,.22+i*.025,.22+i*.055),(.06,.06,.085),patch,.018)
 else:raise ValueError(name)

bpy.ops.object.camera_add(location=(8,8,5.657));camera=bpy.context.object;camera.rotation_euler=(-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=240/(48*math.sqrt(2));camera.data.shift_y=.25;scene.camera=camera
if __name__ == '__main__':
 names=['dyvlinge','perjohan','byakorre','kirribilli','okensand','gullsudare','sofa','table','vacuum','pearl','maree']
 for name in names:
  animations=['idle','walk','sit','sleep','groom'] if name in ['pearl','maree'] else ['idle']
  for anim in animations:
   for frame in range(2 if name in ['pearl','maree'] else 1):
    for q,direction in enumerate(['north','east','south','west']):
     for o in objects:bpy.data.objects.remove(o,do_unlink=True)
     objects=[];model(name,anim,frame)
     for o in objects:
      o.location=Vector((-o.location.y,o.location.x,o.location.z)) if False else o.location
      t=q*math.pi/2; x,y=o.location.x,o.location.y;o.location.x=x*math.cos(t)-y*math.sin(t);o.location.y=x*math.sin(t)+y*math.cos(t);o.rotation_euler.z+=t
      for color in ramps[o['ramp']]:o.data.materials.append(mats[color])
      for face in o.data.polygons:
       n=o.rotation_euler.to_matrix()@face.normal; face.material_index=2 if n.z>.5 else (1 if n.y>.1 else 0)
     bpy.context.view_layer.update()
     scene.render.filepath=str(OUT/f'{name}-{anim}-{direction}-{frame}.png');bpy.ops.render.render(write_still=True)
     if anim=='idle' and frame==0 and q==0:
      bpy.ops.wm.save_as_mainfile(filepath=str(OUT/f'{name}.blend'))
 print('MODEL RENDERS COMPLETE')
