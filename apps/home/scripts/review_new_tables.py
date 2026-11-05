"""Studio geometry review of the three original Stoppino reconstructions."""
import bpy,pathlib
from mathutils import Vector
root=pathlib.Path(__file__).resolve().parents[1]
for name in ['componibili','giano']:
 work=root/'runs/furniture'/name;bpy.ops.wm.open_mainfile(filepath=str(work/f'{name}.blend'))
 scene=bpy.context.scene;scene.render.resolution_x=512;scene.render.resolution_y=512;scene.cycles.samples=24;scene.world.color=(.35,.35,.35)
 camera=scene.camera;target=Vector((0,0,.33 if name=='componibili' else .20));camera.location=target+Vector((2,-3,1.7));camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.ortho_scale=.95 if name=='componibili' else .62;camera.data.shift_y=0
 for pos,power,size in [((2,-3,4),100,3),((-2,-1,3),50,2),((0,2,3),70,2)]:
  bpy.ops.object.light_add(type='AREA',location=pos);light=bpy.context.object;light.data.energy=power;light.data.shape='DISK';light.data.size=size;light.rotation_euler=(-light.location).to_track_quat('-Z','Y').to_euler()
 scene.render.filepath=str(work/'shape-review.png');bpy.ops.render.render(write_still=True)
