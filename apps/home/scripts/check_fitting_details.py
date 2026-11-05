"""Inspect the actual exported meshes for the user's cabinet and mirror corrections."""
import bpy,pathlib,sys,math
from mathutils import Vector
root=pathlib.Path(__file__).resolve().parents[1]
scale=60.72/(48*math.sqrt(1.5))
def load(name):
 path=root/('runs/furniture/'+name+'/'+name+'.blend' if '--staged' in sys.argv else 'assets/source/'+name+'.blend')
 bpy.ops.wm.open_mainfile(filepath=str(path))
def extent(o):
 points=[o.matrix_world@Vector(v) for v in o.bound_box]
 return [min(p[i] for p in points) for i in range(3)],[max(p[i] for p in points) for i in range(3)]
load('kitchen-run')
doors={o['door_role']:o for o in bpy.data.objects if o.get('door_role')}
assert set(doors)=={'fridge','pantry'}
f0,f1=extent(doors['fridge']);p0,p1=extent(doors['pantry'])
assert .82<f1[0]-f0[0]<.86 and .32<p1[0]-p0[0]<.36
assert f1[0]<p0[0],'Fridge must be on the balcony side, pantry beside the sink'
tall_end=p1[0]+3.6
load('kitchen-overheads')
upper_start=min(extent(o)[0][0] for o in bpy.data.objects if o.type=='MESH')+4.45
assert upper_start-tall_end>.43,('Cabinet gap',upper_start-tall_end)
load('bath-mirror')
mirror=next(o for o in bpy.data.objects if o.get('mirror_glass'));m0,m1=extent(mirror)
shelves=[o for o in bpy.data.objects if o.get('open_shelf')]
assert len(shelves)==4 and all(extent(o)[0][0]>m1[0] for o in shelves)
mirror_x=mirror.location.x;mirror_bottom=m0[2]/scale
load('bath-vanity')
tap=next(o for o in bpy.data.objects if o.get('faucet_stem'));t0,t1=extent(tap)
assert abs(tap.location.x-mirror_x)<.01 and t1[2]/scale<mirror_bottom-.2
load('bedroom-robe')
body=max((o for o in bpy.data.objects if o.type=='MESH'),key=lambda o:o.dimensions.x*o.dimensions.y*o.dimensions.z)
b0,b1=extent(body)
assert abs(b1[0]-b0[0]-2.65)<.01 and abs(b1[1]-b0[1]-.6)<.01 and abs((b1[2]-b0[2])/scale-2.4)<.01
print('PASS: narrow pantry + wide fridge, separated overheads, left shelving, tap below mirror, full wardrobe enclosure.')
