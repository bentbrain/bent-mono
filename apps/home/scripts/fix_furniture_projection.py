"""Re-render existing furniture with the room's handedness and exact 2:1 projection."""
import pathlib,sys,math,json,os
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import build_models as m
import bpy
from mathutils import Matrix
m.camera.location=(8,-8,8*math.sqrt(2/3));m.camera.rotation_euler=(-m.camera.location).to_track_quat('-Z','Y').to_euler()
transform=Matrix.Diagonal((1,-1,60.72/(48*math.sqrt(1.5)),1))
for name in os.environ.get('APARTMENT_MODELS','dyvlinge,perjohan,byakorre,kirribilli,okensand,gullsudare,sofa,table,vacuum').split(','):
 work=m.ROOT/'runs/furniture'/name;work.mkdir(parents=True,exist_ok=True)
 manifest=json.loads((m.ROOT/'assets/manifests'/f'{name}.json').read_text())
 (work/'request.json').write_text(json.dumps({'id':name,'name':manifest['displayName'],'footprint':manifest['footprint'],'heightPixels':manifest['heightPixels'],'palette':manifest['palette'],'materials':'Retain existing approved model and palette','references':[f'assets/source/{name}.blend'],'asymmetry':'Retain all model details; correct world-axis mapping and camera slope only.'},indent=2)+'\n')
 for q,direction in enumerate(['north','east','south','west']):
  for o in m.objects:bpy.data.objects.remove(o,do_unlink=True)
  m.objects.clear();m.model(name)
  for o in m.objects:
   t=q*math.pi/2;x,y=o.location.x,o.location.y;o.location.x=x*math.cos(t)-y*math.sin(t);o.location.y=x*math.sin(t)+y*math.cos(t);o.rotation_euler.z+=t
  bpy.context.view_layer.update()
  for o in m.objects:o.matrix_world=transform@o.matrix_world
  bpy.context.view_layer.update()
  for o in m.objects:
   for color in m.ramps[o['ramp']]:o.data.materials.append(m.mats[color])
   for face in o.data.polygons:
    n=o.matrix_world.to_3x3().inverted().transposed()@face.normal;face.material_index=2 if n.z>.5 else 1 if n.y<-.1 else 0
  m.scene.render.filepath=str(m.OUT/f'{name}-idle-{direction}-0.png');bpy.ops.render.render(write_still=True)
  if q==0:bpy.ops.wm.save_as_mainfile(filepath=str(m.OUT/f'{name}.blend'))
print('FURNITURE PROJECTION CORRECTED')
