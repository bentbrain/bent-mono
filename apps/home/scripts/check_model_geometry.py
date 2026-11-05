"""Regression check on the actual approved Blender mesh, not generation parameters."""
import bpy,math,pathlib,sys
from mathutils import Vector
root=pathlib.Path(__file__).resolve().parents[1]
path=root/('runs/furniture/kitchen-run/kitchen-run.blend' if '--staged' in sys.argv else 'assets/source/kitchen-run.blend')
bpy.ops.wm.open_mainfile(filepath=str(path))
rims=[o for o in bpy.data.objects if o.get('sink_rim')]
assert len(rims)==8,f'Expected eight bowl side meshes, found {len(rims)}'
scale=60.72/(48*math.sqrt(1.5))
height=max((o.matrix_world@Vector(v)).z for o in rims for v in o.bound_box)/scale
bottom=min((o.matrix_world@Vector(v)).z for o in rims for v in o.bound_box)/scale
assert height<=.915,f'Raised sink lip: {height:.3f} m versus .910 m benchtop'
assert bottom<.78,f'Bowl is not recessed: {bottom:.3f} m'
print(f'PASS: sink lip {height:.3f} m, bowl bottom {bottom:.3f} m, benchtop .910 m')
