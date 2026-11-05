"""Regression gate: throws stay outside seat meshes; cushions lean back."""
import bpy,pathlib,sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree
root=pathlib.Path(__file__).resolve().parents[1]
failed=[]
for name in ['numero-high','numero-low','fireside-dressed']:
 bpy.ops.wm.open_mainfile(filepath=str(root/'runs/furniture'/name/f'{name}.blend'))
 deps=bpy.context.evaluated_depsgraph_get();verts=[];faces=[]
 for o in [o for o in bpy.data.objects if o.type=='MESH' and any(m.name.startswith(('numero-fabric','finish-primary')) for m in o.data.materials)]:
  evaluated=o.evaluated_get(deps);data=evaluated.to_mesh();offset=len(verts)
  verts.extend(o.matrix_world@v.co for v in data.vertices);faces.extend(tuple(offset+i for i in p.vertices) for p in data.polygons);evaluated.to_mesh_clear()
 tree=BVHTree.FromPolygons(verts,faces)
 cloth=[o for o in bpy.data.objects if o.type=='MESH' and o.name in ['rust-throw','cream-throw','blush-throw']]
 if len(cloth)!=1:raise RuntimeError(name+' must contain exactly one throw')
 for o in cloth:
  if not o.get('cloth_simulation_frozen') or o.get('cloth_simulation_frames',0)<48:
   raise RuntimeError(name+' throw has not been simulated and frozen')
  if o.get('cloth_simulation_max_movement',0)<.005 or any(m.type=='CLOTH' for m in o.modifiers):
   raise RuntimeError(name+' must contain a settled mesh, not live cloth physics')
 buried=0
 for o in cloth:
  samples=[v.co for v in o.data.vertices]+[sum((o.data.vertices[i].co for i in face.vertices),Vector())/len(face.vertices) for face in o.data.polygons]
  for sample_index,sample in enumerate(samples):
   p=o.matrix_world@sample;hit=tree.ray_cast(Vector((p.x,p.y,5)),Vector((0,0,-1)))[0]
   if hit and hit.z>p.z+.003:
    buried+=1
    if buried<4:print('Clipped', 'vertex' if sample_index<len(o.data.vertices) else 'face',tuple(round(v,4) for v in p),'surface',round(hit.z,4))
 cushions=[o for o in bpy.data.objects if o.type=='MESH' and any(m.name.startswith('cushion-purple') for m in o.data.materials)]
 def cushion_normal(o):
  # Export bakes object transforms. Compare the two cloth faces in world space.
  if o.name.startswith('Soft cushion'):
   points=[o.matrix_world@v.co for v in o.data.vertices];half=len(points)//2
   return (sum(points[half:],Vector())/half-sum(points[:half],Vector())/half).normalized()
  return (o.matrix_world.to_3x3()@Vector((0,1,0))).normalized()
 upright=sum(abs(cushion_normal(o).z)<.25 for o in cushions)
 print(f'{name}: {buried} cloth vertex/face samples inside upholstery; {upright} rigid upright cushions',flush=True)
 if buried or upright:failed.append(name)
if failed:raise RuntimeError('Textile clearance / lean failed: '+', '.join(failed))
print('PASS: all throws outside upholstery and cushions reclined',flush=True)
