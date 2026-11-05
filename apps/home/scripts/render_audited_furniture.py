"""Render staged Blender assets in all four directions at the scene's native pixel scale."""
import bpy,math,pathlib,json,os,sys
from mathutils import Matrix,Vector
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import photo_objects
palette=json.loads((ROOT/'assets/palettes/apartment-fixtures-v2.json').read_text())['colors']
colors=[tuple(int(c[i:i+2],16)/255 for i in (1,3,5)) for c in palette]
def linear(v):return ((v+.055)/1.055)**2.4 if v>.04045 else v/12.92
def gamma(v):return 1.055*v**(1/2.4)-.055 if v>.0031308 else 12.92*v
for spec in json.loads((ROOT/'data/furniture-audit.json').read_text())+photo_objects.specs(ROOT):
 name=spec['id']
 if os.environ.get('APARTMENT_MODELS') and name not in os.environ['APARTMENT_MODELS'].split(','):continue
 work=ROOT/'runs/furniture'/name;bpy.ops.wm.open_mainfile(filepath=str(work/f'{name}.blend'))
 objects=[o for o in bpy.data.objects if o.type=='MESH'];
 for o in objects:
  if any(m.name.startswith('seat-pad') for m in o.data.materials):o.hide_render=True
 scene=bpy.context.scene;camera=scene.camera
 camera.location=(8,-8,8*math.sqrt(2/3));camera.rotation_euler=(-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.ortho_scale=240/(48*math.sqrt(2));camera.data.shift_y=.25
 scene.cycles.samples=1;scene.render.resolution_x=256 if name=='checker-rug' else 240;scene.render.resolution_y=256 if name=='checker-rug' else 240;camera.data.ortho_scale=scene.render.resolution_x/(48*math.sqrt(2));camera.data.shift_y=.25
 originals={o:o.matrix_world.copy() for o in objects};ramps={}
 for o in objects:
  original=o.data.materials[0];p=original.node_tree.nodes.get('Principled BSDF');base=[gamma(v) for v in p.inputs['Base Color'].default_value[:3]]
  mats=[]
  for gain in [.63,.84,1]:
   target=[v*gain for v in base];idx=min(range(len(colors)),key=lambda i:sum((a-b)**2 for a,b in zip(target,colors[i])))
   m=bpy.data.materials.new(palette[idx]);m.use_nodes=True;n=m.node_tree.nodes;n.clear();e=n.new('ShaderNodeEmission');output=n.new('ShaderNodeOutputMaterial');e.inputs['Color'].default_value=tuple(linear(v) for v in colors[idx])+(1,);m.node_tree.links.new(e.outputs[0],output.inputs[0]);mats.append(m)
  o.data.materials.clear()
  for m in mats:o.data.materials.append(m)
 for q,direction in enumerate(['north','east','south','west']):
  for o in objects:
   o.matrix_world=Matrix.Rotation(-q*math.pi/2,4,'Z')@originals[o]
   for face in o.data.polygons:
    n=o.matrix_world.to_3x3().inverted().transposed()@face.normal;face.material_index=2 if n.z>.45 else 1 if n.y<-.1 else 0
  scene.render.filepath=str(work/f'{name}-{direction}.png');bpy.ops.render.render(write_still=True)
 print('RENDERED',name,flush=True)
