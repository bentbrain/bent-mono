"""High-resolution geometry review, separate from native pixel contract exports."""
import bpy,pathlib,math
from mathutils import Vector
root=pathlib.Path(__file__).resolve().parents[1]
for name in ['casalino','kd27']:
 work=root/'runs/furniture'/name;bpy.ops.wm.open_mainfile(filepath=str(work/f'{name}.blend'))
 # Default chair has no cushion; preserve this option in the editable source.
 for o in bpy.data.objects:
  if o.type=='MESH' and any(m.name.startswith('seat-pad') for m in o.data.materials):o.hide_render=True
 scene=bpy.context.scene;scene.render.resolution_x=512;scene.render.resolution_y=512;scene.cycles.samples=24;scene.world.color=(.35,.35,.35)
 camera=scene.camera;target=Vector((0,0,.38 if name=='casalino' else .12));camera.location=target+Vector((2,-3,1.4));camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.ortho_scale=.95 if name=='casalino' else .34;camera.data.shift_y=0
 for pos,power,size in [((2,-3,4),100,3),((-2,-1,3),50,2),((0,2,3),70,2)]:
  bpy.ops.object.light_add(type='AREA',location=pos);light=bpy.context.object;light.data.energy=power;light.data.shape='DISK';light.data.size=size;light.rotation_euler=(-light.location).to_track_quat('-Z','Y').to_euler()
 scene.render.filepath=str(work/'shape-review.png');bpy.ops.render.render(write_still=True)

 if name=='casalino':
  for label,offset,target in [('front',(0,-4,.04),(0,0,.38)),('back',(0,4,.04),(0,0,.38)),('top',(0,-.001,4),(0,0,.3))]:
   target=Vector(target);camera.location=target+Vector(offset);camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.ortho_scale=.86
   scene.render.filepath=str(work/f'shape-{label}.png');bpy.ops.render.render(write_still=True)
