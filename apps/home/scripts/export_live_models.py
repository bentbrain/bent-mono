"""Export the reviewed geometry with light-responsive materials for Babylon.js."""
import bpy,pathlib,sys,math,json,os,hashlib
from mathutils import Vector
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'public/models';out.mkdir(exist_ok=True)
names=['dyvlinge','perjohan','byakorre','kirribilli','okensand','gullsudare','sofa','table','vacuum','bath-mirror','bath-shower','bath-toilet','bath-vanity','bedroom-robe','kitchen-overheads','kitchen-run','laundry-sink']
audited_ids={p['id'] for p in json.loads((root/'data/furniture-audit.json').read_text())+json.loads((root/'data/photo-objects.json').read_text())}
names=list(dict.fromkeys(names+sorted(audited_ids)))
def lit(name,color):
 mat=bpy.data.materials.new(name);mat.use_nodes=True
 p=mat.node_tree.nodes.get('Principled BSDF')
 rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
 p.inputs['Base Color'].default_value=tuple(((v+.055)/1.055)**2.4 if v>.04045 else v/12.92 for v in rgb)+(1,)
 p.inputs['Roughness'].default_value=.84
 p.inputs['Specular IOR Level'].default_value=.2
 return mat
for name in names:
 if os.environ.get("APARTMENT_MODELS") and name not in os.environ["APARTMENT_MODELS"].split(","):continue
 source=root/'runs/furniture'/name/f'{name}.blend' if os.environ.get('APARTMENT_STAGED_MODELS') else root/'assets/source'/f'{name}.blend'
 bpy.ops.wm.open_mainfile(filepath=str(source))
 bpy.ops.object.select_all(action='DESELECT');cache={};meshes=[]
 for obj in list(bpy.data.objects):
  if obj.type!='MESH':continue
  if name in audited_ids:
   obj.select_set(True);meshes.append(obj);continue
  # Approved sources have one albedo ramp per part; remove view-baked shading.
  old=obj.data.materials
  color=old[min(1,len(old)-1)].name[:7] if old else '#89908b'
  if not color.startswith('#'):color='#89908b'
  obj.data.materials.clear()
  if 'lamp_shade_band' in obj:
   band=int(obj['lamp_shade_band'])
   for fold in range(2):
    material=lit(f'lamp-diffuser-{band:02}-{fold}', '#fff5d6');material.use_backface_culling=False;obj.data.materials.append(material)
   for face in obj.data.polygons:face.material_index=face.index%2;face.use_smooth=False
  else:
   key='shower-glass' if obj.get('shower_glass') else 'lamp-bulb' if 'lamp_bulb' in obj else 'surface-'+color
   if key not in cache:
    cache[key]=lit(key,color)
    if key=='shower-glass':
     cache[key].node_tree.nodes.get('Principled BSDF').inputs['Alpha'].default_value=.12
     cache[key].surface_render_method='DITHERED';cache[key].use_backface_culling=False
   obj.data.materials.append(cache[key])
   for face in obj.data.polygons:face.material_index=0;face.use_smooth=False
  obj.select_set(True);meshes.append(obj)
 bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join()
 bpy.context.object.name=name
 if name=='orange-cat-clock':
  sys.path.insert(0,str(root/'scripts'));import photo_objects
  photo_objects.clock_morphs(bpy.context.object,60.72/(48*math.sqrt(1.5)))
 bpy.ops.export_scene.gltf(filepath=str(out/f'{name}.glb'),export_format='GLB',use_selection=True,export_animations=False,export_cameras=False,export_lights=False)
 print('EXPORTED',name)
# Preserve all seven approved animations as true deforming meshes, not billboards.
if not os.environ.get('APARTMENT_MODELS'):
 sys.path.insert(0,str(root/'scripts'))
 import build_cats as cats
 from mathutils import Matrix
 transform=cats.f.world_to_blender@cats.source_to_world
 for identity in ['pearl','maree']:
  cats.skin(identity);poses=[];faces=[];groups=[]
  for anim in ['idle','walk','sit','sleep','groom','jump','crouch']:
   for frame in range(8):
    cats.pose(anim,frame);deps=bpy.context.evaluated_depsgraph_get();vertices=[];current_faces=[];current_groups=[]
    for mi,obj in enumerate(cats.models):
     mesh=bpy.data.meshes.new_from_object(obj.evaluated_get(deps),depsgraph=deps);offset=len(vertices)
     center=sum((v.co for v in mesh.vertices),Vector())/len(mesh.vertices)
     for v in mesh.vertices:
      p=v.co.copy()
      if anim=='sleep' and mi>0:p.z=center.z+(p.z-center.z)*.15
      if p.x>1.8:
       blend=min(1,(p.x-1.8)/.45);head=Vector((2.45,0,2.7));p=head+(p-head)*(1+.23*blend)
      p.x*=.93;p.z=p.z*.76 if p.z<1.7 else p.z-.408
      vertices.append(transform@p)
     for face in mesh.polygons:
      ids=[offset+i for i in face.vertices]
      current_faces.append(list(reversed(ids)) if transform.determinant()<0 else ids)
      current_groups.append(face.material_index//3)
     bpy.data.meshes.remove(mesh)
    if not faces:faces=current_faces;groups=current_groups
    assert current_faces==faces and current_groups==groups,'Morph topology or coat drift'
    poses.append((f'{anim}_{frame}',vertices))
  mesh=bpy.data.meshes.new(identity);mesh.from_pydata(poses[0][1],[],faces);mesh.update()
  obj=bpy.data.objects.new(identity,mesh);bpy.context.scene.collection.objects.link(obj)
  for i,ramp in enumerate(cats.ramps):mesh.materials.append(lit(f'{identity}-coat-{i}',ramp[1]))
  for face,group in zip(mesh.polygons,groups):face.material_index=group;face.use_smooth=False
  obj.shape_key_add(name='Basis')
  for name,vertices in poses:
   key=obj.shape_key_add(name=name)
   for target,position in zip(key.data,vertices):target.co=position
  bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
  bpy.ops.export_scene.gltf(filepath=str(out/f'{identity}.glb'),export_format='GLB',use_selection=True,export_animations=False,export_morph=True,export_morph_normal=True,export_cameras=False,export_lights=False)
  bpy.data.objects.remove(obj,do_unlink=True)
  print('EXPORTED',identity,'56 mesh poses')
(out/'manifest.json').write_text(json.dumps({'version':3,'spriteHashes':{p.stem:hashlib.sha256(p.read_bytes()).hexdigest()[:12] for p in (root/'public/sprites').glob('*-catalogue.png')},'hashes':{p.stem:hashlib.sha256(p.read_bytes()).hexdigest()[:12] for p in sorted(out.glob('*.glb'))},'format':'glTF 2.0','units':'metres','heightScale':60.72/(48*math.sqrt(1.5)),'models':names+['pearl','maree'],'catAnimations':['idle','walk','sit','sleep','groom','jump','crouch'],'framesPerAnimation':8,'provenance':'Reviewed Blender source geometry; cats derived from Quaternius CC0 Animal Pack Vol.2'},indent=2)+'\n')
