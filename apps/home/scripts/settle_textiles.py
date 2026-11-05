"""Offline Blender cloth draping. Only the frozen mesh is shipped to the viewer."""
import bpy,bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def freeze_export_modifiers(objects, height=None):
    """Joining meshes drops non-active modifiers; retain cloth thickness in GLB."""
    deps=bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj.modifiers:
            mesh=bpy.data.meshes.new_from_object(obj.evaluated_get(deps))
            obj.modifiers.clear()
            obj.data=mesh
    points=[obj.matrix_world@v.co for obj in objects for v in obj.data.vertices]
    floor=min(p.z for p in points)
    factor=height/(max(p.z for p in points)-floor) if height else 1
    # Evaluated bevel/solidify can extend the calibrated envelope by millimetres.
    # Bake that final envelope directly into the vertices before joining meshes.
    for obj in objects:
        world=obj.matrix_world.copy()
        inverse=world.inverted()
        for vertex in obj.data.vertices:
            point=world@vertex.co
            point.z=(point.z-floor)*factor
            vertex.co=inverse@point
        obj.data.update()


def settle_cloth(cloth, vertices, faces, row_width, frames=72):
    scene=bpy.context.scene
    scene.frame_set(1)
    scene.render.fps=24
    scene.gravity=(0,0,-9.81)
    data=bpy.data.meshes.new('Temporary upholstery collision mesh')
    ground=len(vertices)
    data.from_pydata([*vertices,(-3,-3,0),(3,-3,0),(3,3,0),(-3,3,0)],[],[*faces,(ground,ground+1,ground+2,ground+3)]);data.update()
    bm=bmesh.new();bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(data);bm.free()
    collider=bpy.data.objects.new('Temporary seat collider',data)
    bpy.context.collection.objects.link(collider)
    collider.modifiers.new('Upholstery collision','COLLISION')
    collider.collision.thickness_outer=.009
    collider.collision.thickness_inner=.003
    collider.collision.cloth_friction=45
    pin=cloth.vertex_groups.new(name='Resting upper fold')
    centres=[row_width//5,row_width//2,row_width*4//5] if cloth.name in ['cream-throw','blush-throw'] else [row_width//2]
    pin.add([i+offset for i in centres for offset in [-1,0,1]],.8,'REPLACE')
    modifier=cloth.modifiers.new('Offline gravity drape','CLOTH')
    settings=modifier.settings
    settings.quality=24 if cloth.name=='blush-throw' else 12
    settings.mass=.22
    settings.air_damping=3
    settings.tension_stiffness=18
    settings.compression_stiffness=12
    settings.shear_stiffness=8
    settings.bending_stiffness=.3
    settings.tension_damping=8
    settings.compression_damping=8
    settings.shear_damping=8
    settings.bending_damping=1
    settings.vertex_group_mass=pin.name
    settings.pin_stiffness=1
    collision=modifier.collision_settings
    collision.use_collision=True
    collision.distance_min=.007
    collision.collision_quality=16 if cloth.name=='blush-throw' else 8
    collision.friction=40
    collision.use_self_collision=True
    collision.self_distance_min=.004
    collision.self_friction=25
    modifier.point_cache.frame_start=1
    modifier.point_cache.frame_end=frames
    initial=[v.co.copy() for v in cloth.data.vertices]
    for frame in range(1,frames+1):
        scene.frame_set(frame)
        cloth.evaluated_get(bpy.context.evaluated_depsgraph_get())
        if frame%24==0:print(f'Simulated {cloth.name}: frame {frame}/{frames}',flush=True)
    bpy.context.view_layer.objects.active=cloth
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    cloth['cloth_simulation_frames']=frames
    cloth['cloth_simulation_frozen']=True
    cloth['cloth_simulation_max_movement']=max((v.co-start).length for v,start in zip(cloth.data.vertices,initial))
    print(f'Frozen {cloth.name}: maximum movement {cloth["cloth_simulation_max_movement"]:.3f}m',flush=True)
    # Cloth collision can miss a few millimetres at a sharp upholstery crease.
    # Polish only those contacts after freezing, retaining the simulated folds.
    tree=BVHTree.FromPolygons(vertices,faces)
    frozen=[v.co.copy() for v in cloth.data.vertices]
    def contact_delta(p):
        top=tree.ray_cast(Vector((p.x,p.y,5)),Vector((0,0,-1)))[0]
        if top is None or top.z<p.z-.004:return None
        corrections=[Vector((0,0,top.z+.010-p.z))]
        front=tree.ray_cast(Vector((p.x,5,p.z)),Vector((0,-1,0)))[0]
        if front is not None and front.y>=p.y:corrections.append(Vector((0,front.y+.012-p.y,0)))
        return min(corrections,key=lambda p:p.length)
    for _ in range(6):
        touched=False
        for vertex in cloth.data.vertices:
            delta=contact_delta(vertex.co)
            if delta is not None:vertex.co+=delta;touched=True
        for face in cloth.data.polygons:
            centre=sum((cloth.data.vertices[i].co for i in face.vertices),Vector())/len(face.vertices)
            delta=contact_delta(centre)
            if delta is not None:
                for i in face.vertices:cloth.data.vertices[i].co+=delta
                touched=True
        if not touched:break
    correction=max((v.co-start).length for v,start in zip(cloth.data.vertices,frozen))
    if correction>.06:raise RuntimeError(f'{cloth.name} requires {correction:.3f}m collision repair; retune the simulation')
    cloth['cloth_contact_polish_max']=correction
    cloth.data.update()
    print(f'Contact polish {cloth.name}: {correction:.3f}m maximum',flush=True)
    bpy.data.objects.remove(collider,do_unlink=True)
    bpy.data.meshes.remove(data)
    scene.frame_set(1)
    return [tuple(v.co) for v in cloth.data.vertices]
