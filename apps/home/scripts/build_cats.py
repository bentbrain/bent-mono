"""Custom Pearl/Maree skins and poses on Quaternius's CC0 cat rig."""
import sys,pathlib,math,json
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import build_fittings as f
import bpy
from mathutils import Matrix,Vector,Quaternion
m=f.m;ROOT=m.ROOT
source=ROOT/'assets/source/third-party/quaternius-cat.blend'
with bpy.data.libraries.load(str(source),link=False) as (data,loaded):
 loaded.objects=['Cat','CatArmature'];loaded.actions=['Idle','Walking']
for o in loaded.objects:
 if o is not None:m.scene.collection.objects.link(o)
body=bpy.data.objects['Cat'];rig=bpy.data.objects['CatArmature']
for track in rig.animation_data.nla_tracks:track.mute=True
original=[p.material_index for p in body.data.polygons]
base_positions=[v.co.copy() for v in body.data.vertices]
ramps=[['#c7c8be','#f6f5ee','#ffffff'],['#626865','#89908b','#c7c8be'],['#17121e','#303635','#4e5656'],['#8f5b45','#e4a46d','#ead39d'],['#8f3c55','#f29a8d','#fff5d6']]
materials=[m.mats[c] for ramp in ramps for c in ramp]
body.data.materials.clear()
for mat in materials:body.data.materials.append(mat)
# Small eyes follow the head bone through the same armature modifier.
eyes=[]
for side in [-1,1]:
 o=m.ell((2.66,side*.449,2.77),(.12,.06,.14),'dark')
 bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 # Bake the eye centre into mesh coordinates before using the source rig.
 o.data.transform(o.matrix_world);o.matrix_world=Matrix.Identity(4)
 group=o.vertex_groups.new(name='Bone.003');group.add(list(range(len(o.data.vertices))),1,'REPLACE')
 mod=o.modifiers.new('Head attachment','ARMATURE');mod.object=rig
 for mat in materials:o.data.materials.append(mat)
 for face in o.data.polygons:face.material_index=6
 eyes.append(o)
models=[body,*eyes]
original_modes={p.name:p.rotation_mode for p in rig.pose.bones}

def control(name,delta):
 p=rig.pose.bones[name];p.location+=p.bone.matrix_local.to_3x3().inverted()@Vector(delta)

def turn(name,angle):
 p=rig.pose.bones[name];p.rotation_mode='QUATERNION'
 axis=p.bone.matrix_local.to_quaternion().inverted()@Vector((0,1,0))
 p.rotation_quaternion=Quaternion(axis,angle)

def pose(anim,frame):
 rig.animation_data.action=None
 for p in rig.pose.bones:p.matrix_basis=Matrix.Identity(4);p.rotation_mode=original_modes[p.name]
 rig.animation_data.action=bpy.data.actions['Walking' if anim in ['walk','crouch'] else 'Idle']
 m.scene.frame_set(frame*5 if anim in ['idle','walk','crouch'] else 0);bpy.context.view_layer.update()
 if anim in ['idle','walk']:return
 rig.animation_data.action=None
 if anim=='crouch':
  control('Bone',(0,0,-1.06));turn('Bone.002',.32);turn('Bone.004',.95);turn('Bone.005',.45)
 elif anim=='sit' or anim=='groom':
  control('Bone',(0,0,-.7));turn('Bone',-.28)
  for name in ['IKBackLeft','IKBackRight']:control(name,(.5,0,0))
  if anim=='groom':
   control('IKFrontLeft',(.30,0,1.0+.15*math.sin(frame*math.tau/8)))
   turn('Bone.003',.35+.12*math.sin(frame*math.tau/8))
 elif anim=='sleep':
  control('Bone',(0,0,-1.12))
  for name in ['IKFrontLeft','IKFrontRight']:control(name,(-.5,0,.12))
  for name in ['IKBackLeft','IKBackRight']:control(name,(.6,0,.12))
  turn('Bone.002',.45);turn('Bone.004',.95);turn('Bone.005',.45)
 elif anim=='jump':
  tuck=math.sin(frame/7*math.pi)
  control('Bone',(0,0,-.3*(1-tuck)))
  for name in ['IKFrontLeft','IKFrontRight']:control(name,(-.35*tuck,0,.55*tuck))
  for name in ['IKBackLeft','IKBackRight']:control(name,(.45*tuck,0,.6*tuck))
 bpy.context.view_layer.update()

def skin(identity):
 for face,old in zip(body.data.polygons,original):
  p=sum((base_positions[i] for i in face.vertices),Vector())/len(face.vertices)
  x,y,z=p;group=0
  if old==2:group=4
  elif identity=='pearl':
   if (x< -1.75 and z>2) or (-1.5<x<.8 and z>2.05+abs(y)*.12) or (x>1.9 and z>2.8 and y<.1):group=1
  else:
   if x< -1.75 and z>2 or -1.5<x<-.25 and z>1.95 or x>1.9 and z>2.7 and y<0:group=2
   if -.15<x<1.2 and z>1.9 and y>.02 or x>1.9 and z>2.8 and y>=0:group=3
  if old==1 and z<1.1:group=0
  face.material_index=group*3

concept='--concept' in sys.argv
m.scene.render.resolution_x=240;m.scene.render.resolution_y=240;m.camera.data.ortho_scale=240/(48*math.sqrt(2))
scale=.135
source_to_world=Matrix(((0,scale*1.15,0,0),(-scale,0,0,-.027),(0,0,scale,0),(0,0,0,1)))
if __name__ == '__main__':
 for identity in ['pearl','maree']:
  skin(identity);work=ROOT/'runs/characters'/f'{identity}-v3';work.mkdir(parents=True,exist_ok=True)
  (work/'request.json').write_text(json.dumps({'id':f'{identity}-v3','identity':identity,'source':'Quaternius Cat, Animal Pack Vol.2, CC0','references':['https://opengameart.org/content/animated-animales-low-poly'],'markings':'white and grey' if identity=='pearl' else 'white, black and orange calico','dimensionsMetres':{'width':.24,'depth':.78,'height':.65},'palette':'apartment-fixtures-v2','animations':['idle','walk','sit','sleep','groom','jump','crouch'],'frames':8,'asymmetry':'Body and face markings assigned on the rigged mesh, preserved through all poses and directions.'},indent=2)+'\n')
  for anim in ['idle'] if concept else ['crouch'] if '--crouch' in sys.argv else ['sit','sleep','groom'] if '--repair-poses' in sys.argv else ['idle','walk','sit','sleep','groom','jump','crouch']:
   for frame in [0] if concept else range(8):
    pose(anim,frame)
    deps=bpy.context.evaluated_depsgraph_get()
    meshes=[bpy.data.meshes.new_from_object(o.evaluated_get(deps),depsgraph=deps) for o in models]
    for o in models:o.hide_render=True
    for q,direction in enumerate(['north','east','south','west']):
     transform=f.world_to_blender@Matrix.Rotation(q*math.pi/2,4,'Z')@source_to_world
     rendered=[]
     for mi,mesh in enumerate(meshes):
      data=mesh.copy()
      if anim=='sleep' and mi>0:
       centre=sum((v.co for v in data.vertices),Vector())/len(data.vertices)
       for v in data.vertices:v.co.z=centre.z+(v.co.z-centre.z)*.15
      for v in data.vertices:
       # Keep the licensed rig's gait, with a rounder head and shorter pet proportions.
       if v.co.x>1.8:
        blend=min(1,(v.co.x-1.8)/.45);centre=Vector((2.45,0,2.7))
        v.co=centre+(v.co-centre)*(1+.23*blend)
       v.co.x*=.93
       v.co.z=v.co.z*.76 if v.co.z<1.7 else v.co.z-.408
      data.transform(transform)
      if transform.determinant()<0:data.flip_normals()
      data.update();o=bpy.data.objects.new('Baked pose',data);m.scene.collection.objects.link(o);rendered.append(o)
      for face in data.polygons:
       group=face.material_index//3;face.material_index=group*3+(2 if face.normal.z>.5 else 1 if face.normal.y<-.1 else 0)
     m.scene.render.filepath=str(work/f'{anim}-{direction}-{frame}.png');bpy.ops.render.render(write_still=True)
     for o in rendered:
      data=o.data;bpy.data.objects.remove(o,do_unlink=True);bpy.data.meshes.remove(data)
    for mesh in meshes:bpy.data.meshes.remove(mesh)
    for o in models:o.hide_render=False
  pose('idle',0)
  bpy.ops.wm.save_as_mainfile(filepath=str(work/f'{identity}-v3.blend'))
 print('CAT CONCEPTS COMPLETE' if concept else 'CAT ANIMATIONS COMPLETE')
