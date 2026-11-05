"""Photo-derived furniture in metres. Review staged output before approval.
Run with Blender --background --python scripts/build_audited_furniture.py.
The catalogue JSON is the shared dimensional source; no private receipts are exported.
"""
import bpy,sys,pathlib,json,math,os
from mathutils import Vector,Matrix
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import build_models as old
import photo_objects
PHOTO_SPECS=photo_objects.specs(ROOT)
SPECS=json.loads((ROOT/'data/furniture-audit.json').read_text())+PHOTO_SPECS
OUT=ROOT/'runs/furniture-audit';OUT.mkdir(exist_ok=True,parents=True)
HEIGHT_SCALE=60.72/(48*math.sqrt(1.5))
parts=[];materials={}
def mat(role,color):
 key=role+'|'+color
 if key in materials:return materials[key]
 m=bpy.data.materials.new(role);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
 p.inputs['Base Color'].default_value=tuple(((v+.055)/1.055)**2.4 if v>.04045 else v/12.92 for v in rgb)+(1,)
 p.inputs['Roughness'].default_value=.78 if 'fabric' in role else .42
 p.inputs['Metallic'].default_value=.5 if role=='steel' else 0
 materials[key]=m;return m
P=None
WHITE=mat('diffuser','#f0ede0');STEEL=mat('steel','#abb4af');DARK=mat('fixed-dark','#303531');CREAM=mat('fixed-ivory','#e8dfc9');WOOD=mat('fixed-bamboo','#be945f')
def finish(o,m):
 o.data.materials.clear();o.data.materials.append(m);parts.append(o);return o

def box(pos,size,m=None,r=.005,segments=3):
 bpy.ops.mesh.primitive_cube_add(size=1,location=pos);o=bpy.context.object;o.scale=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 if r:
  mod=o.modifiers.new('Rounded moulding','BEVEL');mod.width=min(r,min(size)/2*.95);mod.segments=segments;bpy.ops.object.modifier_apply(modifier=mod.name)
 return finish(o,m or P)
def cylinder(pos,r,h,m=None,n=40):
 bpy.ops.mesh.primitive_cylinder_add(vertices=n,radius=r,depth=h,location=pos);return finish(bpy.context.object,m or P)
def cone(pos,r1,r2,h,m=None,n=32):
 bpy.ops.mesh.primitive_cone_add(vertices=n,radius1=r1,radius2=r2,depth=h,location=pos);return finish(bpy.context.object,m or P)
def sphere(pos,size,m=None):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=16,radius=1,location=pos);o=bpy.context.object;o.scale=size;return finish(o,m or P)
def mesh(name,verts,faces,m=None):
 d=bpy.data.meshes.new(name);d.from_pydata(verts,[],faces);d.update();o=bpy.data.objects.new(name,d);bpy.context.collection.objects.link(o);return finish(o,m or P)
def tube(points,r,m=None):
 for a,b in zip(points,points[1:]):
  a,b=Vector(a),Vector(b);o=cylinder((a+b)/2,r,(b-a).length,m,8);o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler()
def lathe(profile,m=None,n=64,name='turned-shell'):
 verts=[(r*math.cos(i*math.tau/n),r*math.sin(i*math.tau/n),z) for r,z in profile for i in range(n)]
 return mesh(name,verts,[(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for j in range(len(profile)-1) for i in range(n)],m)
def rr(w,d,r,n=8):
 result=[]
 for x,y,start in [(w/2-r,d/2-r,0),(-w/2+r,d/2-r,90),(-w/2+r,-d/2+r,180),(w/2-r,-d/2+r,270)]:
  for i in range(n+1):
   t=math.radians(start+i*90/n);result.append((x+r*math.cos(t),y+r*math.sin(t)))
 return result

def ring(outer,inner,low,high,m=None,name='open-shell'):
 n=len(outer);v=[(x,y,z) for z,pts in [(low,outer),(high,outer),(high,inner),(low,inner)] for x,y in pts]
 f=[]
 for band in range(4):
  for i in range(n):f.append((band*n+i,band*n+(i+1)%n,((band+1)%4)*n+(i+1)%n,((band+1)%4)*n+i))
 return mesh(name,v,f,m)
def cut(o,cutter):
 bpy.context.view_layer.objects.active=o;mod=o.modifiers.new('Open moulded aperture','BOOLEAN');mod.operation='DIFFERENCE';mod.solver='EXACT';mod.object=cutter;bpy.ops.object.modifier_apply(modifier=mod.name);parts.remove(cutter);bpy.data.objects.remove(cutter,do_unlink=True)

def make(spec):
 global P
 name=spec['id'];P=mat('finish-primary',spec['finishes'][0]['color'] if spec['finishes'] else '#e6e3d7')
 if name=='downlight':
  ring(rr(.105,.105,.0524,16),rr(.083,.083,.0414,16),0,.025,P,'downlight-trim')
  sphere((0,0,.010),(.0417,.0417,.008),WHITE)
 elif name=='checker-rug':
  for x in range(8):
   for y in range(12):box((-1+(x+.5)*.25,-1.5+(y+.5)*.25,.005),(.25,.25,.01),P if (x+y)%2 else CREAM,.002)
 elif name=='fireside':
  # One continuous foam body: curved low seat, raised front lip and pleated reclined back.
  profile=[(-.43,.025),(-.50,.14),(-.49,.48),(-.42,.7),(-.35,.68),(-.31,.59),(-.26,.5),(-.20,.41),(-.13,.34),(-.04,.30),(.07,.29),(.19,.31),(.32,.36),(.43,.39),(.50,.34),(.49,.18),(.43,.055),(.24,.02),(-.1,.015)]
  # Smooth the complete cross-section, then wrinkle the continuous fabric surface.
  path=[]
  for j in range(len(profile)):
   a,b,c,d=[Vector(profile[(j+k)%len(profile)]) for k in [-1,0,1,2]]
   for k in range(6):
    t=k/6;v=.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t);path.append((v.x,v.y,j+t))
  n=97;verts=[]
  for i in range(n):
   x=-.9+1.8*i/(n-1);edge=(abs(x)/.9)**16;seam=math.cos(x/1.8*math.pi*5)**24
   for y,z,j in path:
    active=3.5<j<14
    wrinkle=.012*math.cos(j*math.pi*2)*(1-.45*seam) if active else 0
    verts.append((x,y*(1-.09*edge),.25+(z-.25)*(1-.12*edge)-(.022*seam if active else 0)+wrinkle))
  k=len(path);faces=[(i*k+j,i*k+(j+1)%k,(i+1)*k+(j+1)%k,(i+1)*k+j) for i in range(n-1) for j in range(k)]
  faces.extend([tuple(range(k-1,-1,-1)),tuple((n-1)*k+j for j in range(k))]);o=mesh('continuous-pleated-foam',verts,faces)
  for f in o.data.polygons:f.use_smooth=True
 elif name=='componibili':
  for x in [-.125,.125]:
   for y in [-.125,.125]:
    wheel=cylinder((x,y,.025),.025,.023,DARK,24);wheel.rotation_euler.x=math.pi/2
    cylinder((x,y,.045),.008,.035,STEEL,12)
  shell=lathe([(.20,.059),(.21,.07),(.21,.676),(.207,.69),(.195,.69),(.195,.675),(.198,.07),(.20,.059)],P,128,'modular-cylinder')
  cylinder((0,0,.066),.201,.012,P,96)
  for low,high in [(.08,.43),(.457,.661)]:
   cutter=box((0,.18,(low+high)/2),(.342,.25,high-low),DARK,.025,8);cut(shell,cutter)
   verts=[];n=80
   for z in [low+.004,high-.004]:
    for i in range(n+1):
     a=math.pi/2-.958+1.916*i/n;verts.append((.209*math.cos(a),.209*math.sin(a),z))
   door=mesh('Curved sliding door',verts,[(i,i+1,n+2+i,n+1+i) for i in range(n)],P)
   mod=door.modifiers.new('Door thickness','SOLIDIFY');mod.thickness=.009;bpy.context.view_layer.objects.active=door;bpy.ops.object.modifier_apply(modifier=mod.name)
   hole=cylinder((-.101,.185,low+(high-low)*.55),.022,.16,DARK,48);hole.rotation_euler.x=math.pi/2;cut(door,hole)
  cylinder((0,0,.67),.199,.012,P,96)
  for z in [.445]:lathe([(.2102,z-.001),(.2105,z),(.2102,z+.001)],P,128)
  for o in parts:
   for f in o.data.polygons:f.use_smooth=True
 elif name=='giano':
  shell=lathe([(0,0),(.164,0),(.17,.008),(.179,.18),(.192,.38),(.195,.394),(.191,.40),(.178,.40),(.176,.34),(.155,.12),(0,.12)],P,128,'Giano moulded shell')
  opening=box((0,.175,.237),(.298,.31,.183),P,.073,12);cut(shell,opening)
  # Single-colour inset top requested in place of the listing's contrasting insert.
  cylinder((0,0,.387),.181,.012,P,96)
  bevel=shell.modifiers.new('Rounded opening lip','BEVEL');bevel.width=.006;bevel.segments=4;bpy.context.view_layer.objects.active=shell;bpy.ops.object.modifier_apply(modifier=bevel.name)
  for o in parts:
   for f in o.data.polygons:f.use_smooth=True
 elif name=='docksta':
  lathe([(0,0),(.23,0),(.285,.01),(.295,.022),(.285,.035),(.22,.05),(.135,.075),(.085,.12),(.047,.24),(.04,.55),(.06,.65),(.12,.7),(.2,.722),(0,.722)])
  lathe([(0,.724),(.5,.724),(.515,.735),(.507,.75),(0,.75)])
 elif name=='rimforsa':
  box((0,0,.9),(1.2,.635,.04),WOOD,.009)
  for x in [-.535,.535]:
   for y in [-.25,.25]:box((x,y,.44),(.033,.033,.86),STEEL,.003);cylinder((x,y,.014),.025,.028,DARK)
  for x in [-.265,.265]:
   box((x,0,.792),(.51,.5,.154),STEEL,.006)
   box((x,.259,.786),(.48,.012,.135),STEEL,.006)
   tube([(x-.16,.276,.806),(x-.16,.297,.806),(x+.16,.297,.806),(x+.16,.276,.806)],.008,STEEL)
  box((0,0,.45),(1.06,.5,.018),STEEL,.004)
  for y in [-.25,.25]:tube([(-.535,y,.12),(.535,y,.12)],.009,STEEL)
  for i in range(20):tube([(-.51+i*1.02/19,-.25,.12),(-.51+i*1.02/19,.25,.12)],.0035,STEEL)
  for x in [-.566,.566]:
   tube([(x,-.21,.8),(x,.21,.8)],.008,STEEL)
   for y in [-.16,0,.16]:tube([(x,y,.81),(x+.012,y,.77),(x+.026,y,.773)],.004,STEEL)
 elif name=='gullsudare':
  profile=[]
  for j in range(1,48):
   t=math.pi*j/48;profile.append((.35*math.sin(t),.35-.35*math.cos(t)))
  lathe(profile,WHITE,64,'paper-globe-diffuser')
  for j in range(1,24):
   t=math.pi*j/24;r=.3505*math.sin(t);z=.35-.35*math.cos(t)
   lathe([(r-.0015,z-.0015),(r+.0015,z),(r-.0015,z+.0015)],mat('paper-ribs','#c7c8be'),64)
 elif name=='dejsa':
  # Beige glass cylinder, with a gently rolled foot and a separate opal cap.
  lathe([(0,0),(.055,0),(.062,.002),(.065,.007),(.065,.146),(.063,.153),(.058,.156),(0,.156)],P,96,'dejsa-beige-glass-base')
  cylinder((0,0,.156),.043,.008,STEEL,96)
  # Soft shoulder, nearly flat crown and tucked underside from the IKEA photos.
  profile=[(0,.28),(.026,.28),(.053,.277),(.080,.269),(.102,.255),(.119,.234),(.128,.212),(.130,.193),(.126,.173),(.115,.159),(.094,.150),(.066,.146),(0,.146)]
  smooth=[]
  for j in range(len(profile)-1):
   a,b,c,d=[Vector(profile[max(0,min(len(profile)-1,j+k))]) for k in [-1,0,1,2]]
   for step in range(6):
    t=step/6;v=.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t)
    smooth.append((max(0,v.x),v.y))
  smooth.append(profile[-1]);lathe(smooth,mat('dejsa-diffuser','#f0efea'),96,'dejsa-opal-glass-shade')
  # Short rear cable exit remains on the same physical side in every view.
  tube([(0,-.060,.019),(0,-.073,.017)],.004,STEEL)
  tube([(0,-.073,.017),(.011,-.091,.008),(.032,-.103,.003)],.0025,mat('fixed-cord','#a59b8b'))
  for o in parts:
   for f in o.data.polygons:f.use_smooth=True
 elif name=='blasverk':
  lathe([(0,0),(.074,0),(.08,.006),(.077,.01),(0,.01)])
  cylinder((0,0,.135),.008,.25)
  lathe([(0,.248),(.063,.248),(.086,.263),(.095,.285),(.092,.3),(0,.3)],WHITE)
  lathe([(0,.30),(.095,.30),(.088,.323),(.07,.343),(.035,.358),(0,.36)])
 elif name.startswith('era300'):
  h=.956 if name.endswith('stand') else 0
  if h:
   cylinder((0,0,.018),.16,.036,P,64);box((0,-.032,.49),(.042,.04,.92),P,.018);box((0,0,.948),(.16,.11,.016),P,.015)
  verts=[];n=48
  for y,scale in [(-.0925,1),(-.07,1),(-.01,.76),(.035,.88),(.084,1),(.0925,.96)]:
   for j in range(n):
    t=j*math.tau/n;c,s=math.cos(t),math.sin(t);verts.append((.13*scale*math.copysign(abs(c)**.65,c),y,h+.08+.08*scale*math.copysign(abs(s)**.65,s)))
  faces=[(i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j) for i in range(5) for j in range(n)]+[tuple(range(n-1,-1,-1)),tuple(5*n+j for j in range(n))]
  mesh('era-hourglass-grille',verts,faces)
  # Perforations stay physical-side details and use subdued contrast at native pixel scale.
  for row in range(5):
   for col in range(14):sphere((-.102+col*.0156,.093,h+.04+row*.02),(.0018,.001,.0018),mat('grille-holes','#828984'))
  box((0,-.029,h+.15),(.071,.038,.006),P,.01);box((0,-.022,h+.155),(.045,.006,.003),DARK,.002)
 elif name=='arc-ultra':
  box((0,0,.0375),(1.178,.1106,.075),P,.036)
  box((0,-.022,.074),(.15,.046,.002),P,.006)
  for i in range(55):box((-.56+i*.0207,.055,.037),(.0014,.001,.035),mat('grille-holes','#777e79'),0)
 elif name=='sub4':
  o=ring(rr(.402,.389,.038),rr(.158,.136,.045),-.079,.079,P,'sub-open-centre')
  # Ring plane xy becomes xz; the opening passes right through the cabinet.
  o.rotation_euler.x=math.pi/2;o.location.z=.1945
  box((.116,0,.1945),(.006,.092,.10),DARK,.003);box((-.116,0,.1945),(.006,.092,.10),DARK,.003)
 elif name=='lg-g4':
  box((0,0,.3515),(1.222,.0272,.703),mat('fixed-metal','#414542'),.006)
  box((0,.014,.3515),(1.207,.001,.684),mat('screen','#111a1d'),.002)
 elif name=='totem':
  box((0,0,.017),(.39,.366,.034),DARK,.018)
  box((0,-.005,.196),(.365,.342,.338),P,.023)
  box((0,.173,.307),(.13,.01,.02),DARK,.008)
  box((0,-.156,.402),(.34,.03,.79),P,.01)
  box((0,0,.594),(.39,.366,.393),P,.028)
  box((0,0,.8),(.39,.366,.028),DARK,.014)
  box((0,.177,.782),(.06,.012,.015),STEEL,.004)
 elif name=='casalino':
  # A single wraparound moulded shell, with real apertures. This is not a pair of rods.
  n=160;rows=96;verts=[]
  for row in range(rows+1):
   t=row/rows
   for j in range(n+1):
    u=.5-.5*math.cos(math.pi*j/n)
    top=.46+.26*math.sqrt(max(0,math.sin(math.pi*u)));z=t*top
    # An open U, not a circular arc: front ends face straight ahead at fixed X.
    side=1 if u<=.5 else -1;v=2*u if u<=.5 else 2*(1-u)
    c=1-v;waist=math.exp(-((z-.23)/.16)**2)
    x=c**3*.255+3*c*c*v*(.255+.085*t**3)+3*c*v*v*.26
    y=c**3*.245+3*c*c*v*.04+3*c*v*v*(-.27)+v**3*(-.27)
    rear=v*v*(3-2*v)
    y+=.105*waist*rear-.045*t**8*rear
    verts.append((side*x,y,z))
  shell=mesh('casalino-continuous-moulding',verts,[(r*(n+1)+j,r*(n+1)+j+1,(r+1)*(n+1)+j+1,(r+1)*(n+1)+j) for r in range(rows) for j in range(n)])
  sol=shell.modifiers.new('Shell thickness','SOLIDIFY');sol.thickness=.016;sol.offset=0;bpy.context.view_layer.objects.active=shell;bpy.ops.object.modifier_apply(modifier=sol.name)
  cutter=box((0,-.025,.237),(.8,.320,.315),DARK,.12,16);cut(shell,cutter)
  cutter=box((0,0,.228),(.455,.9,.326),DARK,.035,16);cut(shell,cutter)
  cutter=sphere((0,-.035,.539),(.7,.165,.110),DARK);cut(shell,cutter)
  # Round the moulded aperture and arm edges, retaining the pointed floor termination.
  bevel=shell.modifiers.new('Soft moulded edges','BEVEL');bevel.width=.006;bevel.segments=4;bevel.limit_method='ANGLE';bevel.angle_limit=.65
  bpy.context.view_layer.objects.active=shell;bpy.ops.object.modifier_apply(modifier=bevel.name)
  # A rounded continuous rim follows the whole arm/back/front boundary.
  boundary=[verts[r*(n+1)] for r in range(rows)]+verts[rows*(n+1):]+[verts[r*(n+1)+n] for r in range(rows-1,-1,-1)]
  curve=bpy.data.curves.new('Continuous rolled arm rim','CURVE');curve.dimensions='3D';curve.bevel_depth=.006;curve.bevel_resolution=4;curve.use_fill_caps=True
  path=curve.splines.new('POLY');path.points.add(len(boundary)-1)
  for point,co in zip(path.points,boundary):point.co=(*co,1)
  rim=bpy.data.objects.new('Rounded arm and front lip',curve);bpy.context.collection.objects.link(rim);bpy.ops.object.select_all(action='DESELECT');rim.select_set(True);bpy.context.view_layer.objects.active=rim;bpy.ops.object.convert(target='MESH');finish(bpy.context.object,P)
  # Shallow seat bowl: raised sides/back blend directly into the same moulding.
  profile=[(0,.408),(.25,.408),(.5,.410),(.75,.418),(.90,.429),(.98,.438),(1,.437),(1.012,.431),(1,.421),(.95,.417),(.75,.405),(.5,.397),(.25,.395),(0,.395)]
  # The user's overhead photographs show a broad front tapering into the back.
  control=[(0,.243),(.245,.212),(.222,.065),(.160,-.145),(0,-.254),(-.160,-.145),(-.222,.065),(-.245,.212)]
  outline=[]
  for j in range(len(control)):
   a,b,c,d=[Vector(control[(j+k)%len(control)]) for k in [-1,0,1,2]]
   for k in range(20):
    t=k/20;point=.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t);outline.append(point)
  seatverts=[];segments=len(outline)
  for radius,z in profile:
   for point in outline:
    rear=max(0,-point.y/.254)
    seatverts.append((radius*point.x,radius*point.y,z+.03*rear*radius**4))
  mesh('Dished seat blended into shell',seatverts,[(k*segments+j,k*segments+(j+1)%segments,(k+1)*segments+(j+1)%segments,(k+1)*segments+j) for k in range(len(profile)-1) for j in range(segments)])
  # Fuse overlapping plastic and soften the junctions into one watertight moulding.
  bpy.ops.object.select_all(action='DESELECT')
  for o in parts:o.select_set(True)
  bpy.context.view_layer.objects.active=shell;bpy.ops.object.join();parts[:]=[shell]
  remesh=shell.modifiers.new('Single moulded plastic volume','REMESH');remesh.mode='VOXEL';remesh.voxel_size=.002;remesh.use_smooth_shade=True;bpy.ops.object.modifier_apply(modifier=remesh.name)
  smooth=shell.modifiers.new('Continuous seat and arm transitions','SMOOTH');smooth.factor=.65;smooth.iterations=24;bpy.ops.object.modifier_apply(modifier=smooth.name)
  decimate=shell.modifiers.new('Preserve curved silhouette','DECIMATE');decimate.ratio=.38;bpy.ops.object.modifier_apply(modifier=decimate.name)
  # Slightly dished seat pad is optional at runtime and leaves the moulded seat visible.
  padprofile=[(0,.428),(.5,.430),(.8,.437),(.94,.444),(1,.443),(1,.431),(.8,.426),(.5,.413),(0,.412)]
  padverts=[(.91*r*p.x,.91*r*p.y,z+.03*max(0,-p.y/.254)*r**4) for r,z in padprofile for p in outline]
  mesh('Optional fitted cushion',padverts,[(k*segments+j,k*segments+(j+1)%segments,(k+1)*segments+(j+1)%segments,(k+1)*segments+j) for k in range(len(padprofile)-1) for j in range(segments)],mat('seat-pad','#272b29'))
  for o in parts:
   for f in o.data.polygons:f.use_smooth=True
 elif name.startswith('stoppino-'):
  h=spec['h'];index=['small','medium','large'].index(name.split('-')[1]);offset=math.radians(index*30)
  lathe([(0,h-.038),(.224,h-.038),(.228,h-.032),(.228,h-.026),(0,h-.026)],P,128,'recessed-tabletop')
  # The raised tray rim dips into each leg; its bead continues down the panel edges.
  count=192;rimverts=[]
  for j in range(count):
   theta=j*math.tau/count;distance=min(abs((theta-offset-k*math.tau/3+math.pi)%math.tau-math.pi) for k in range(3))
   dip=.5*(1+math.cos(math.pi*distance/.27)) if distance<.27 else 0
   top=h-.026*dip
   for radius,z in [(.215,h-.032),(.217,top-.008),(.220,top-.002),(.225,top),(.230,top-.002),(.235,top-.007),(.235,h-.033),(.230,h-.038),(.215,h-.038)]:
    rimverts.append(((radius-.012*dip)*math.cos(theta),(radius-.012*dip)*math.sin(theta),z))
  bands=9
  mesh('scalloped-continuous-tray-rim',rimverts,[(j*bands+k,((j+1)%count)*bands+k,((j+1)%count)*bands+(k+1)%bands,j*bands+(k+1)%bands) for j in range(count) for k in range(bands)])
  for leg in range(3):
   angle=leg*math.tau/3+offset;v=[];steps=32
   for row in range(2):
    for j in range(steps+1):
     u=-1+2*j/steps;r=.208+.013*u*u;tangent=.050*u;z=0 if row==0 else h-.026+.022*u**4
     v.append((r*math.cos(angle)-tangent*math.sin(angle),r*math.sin(angle)+tangent*math.cos(angle),z))
   o=mesh('straight-channel-leg',v,[(j,j+1,steps+2+j,steps+1+j) for j in range(steps)])
   sol=o.modifiers.new('Moulded panel thickness','SOLIDIFY');sol.thickness=.010;sol.offset=0;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=sol.name)
   for side in [-1,1]:
    x=.221*math.cos(angle)-side*.05*math.sin(angle);y=.221*math.sin(angle)+side*.05*math.cos(angle)
    cylinder((x,y,(h-.008)/2),.005,h-.008,P,32);sphere((x,y,h-.008),(.005,.005,.005),P)
  for o in parts:
   for f in o.data.polygons:f.use_smooth=True
 elif name=='kd27':
  # Two facing oval windows cut into a glossy cylindrical cradle.
  shell=lathe([(.122,0),(.125,.004),(.125,.171),(.121,.175),(.118,.17),(.118,.007),(.122,0)],P,96,'kd27-open-cradle')
  cutter=box((0,0,.078),(.187,.40,.112),DARK,.050,16);cut(shell,cutter)
  lathe([(0,.008),(.118,.008),(.119,.016),(0,.016)],mat('fixed-white','#f0ede0'),96,'kd27-white-base-insert')
  # White upper and lower diffuser halves, with the small top ventilation opening.
  lathe([(.014,.24),(.034,.238),(.060,.231),(.085,.218),(.105,.200),(.118,.179),(.120,.165),(.118,.143),(.111,.122),(.101,.105),(.087,.094),(.065,.090),(0,.090)],WHITE,96,'kd27-domed-diffuser')
  for o in parts:
   for f in o.data.polygons:f.use_smooth=True
  shell.data.update()
  normals=[None]*len(shell.data.loops)
  for f in shell.data.polygons:
   centre=f.center;radius=math.hypot(centre.x,centre.y)
   radial_surface=abs(f.normal.z)<.35 and (radius>.123 or .116<radius<.120)
   for li in f.loop_indices:
    v=shell.data.vertices[shell.data.loops[li].vertex_index].co
    radial=Vector((v.x,v.y,0)).normalized()
    normals[li]=tuple(radial if radius>.123 else -radial) if radial_surface else tuple(f.normal)
  shell.data.normals_split_custom_set(normals)
 elif name=='magazine-rack':
  for y,h,bottom in [(-.069,.255,0),(-.023,.345,.065),(.023,.345,.065),(.069,.255,0)]:
   outer=[(x,yy+y) for x,yy in rr(.4,.046,.021)];inner=[(x,yy+y) for x,yy in rr(.390,.036,.016)]
   ring(outer,inner,bottom,h,P,'open-pocket');box((0,y,bottom+.004),(.37,.035,.008),P,.005)
  from magazine_contents import fill_rack
  fill_rack(box=box,mesh=mesh,mat=mat,parts=parts)
 elif name=='byakorre':
  for x in [-.39,.39]:
   for dx in [-.008,.008]:tube([(x+dx,-.145,.015),(x+dx,-.145,1.55),(x+dx,-.13,1.565),(x+dx,.13,1.565),(x+dx,.145,1.55),(x+dx,.145,.015),(x+dx,-.145,.015)],.005,STEEL)
   for z in [.13,.48,.84,1.20]:tube([(x,-.145,z),(x,.145,z)],.004,STEEL)
  tube([(-.39,-.15,.02),(.39,-.15,.30)],.004,STEEL);tube([(.39,-.15,.02),(-.39,-.15,.30)],.004,STEEL)
  for i,z in enumerate([.30,.66,1.025,1.39]):
   box((0,0,z-.009),(1.7,.32,.018),P,.002)
   edge=mat('edge-'+str(i),['#428198','#c7ab3d','#bc4939','#4c7856'][i]);box((0,.16,z-.009),(1.7,.003,.018),edge,.001)
 elif name=='perjohan':
  for x in [-.455,.455]:
   side=box((x,0,.214),(.027,.28,.428),P,.004)
   cutter=box((x,0,.018),(.10,.16,.105),DARK,.024);cut(side,cutter)
  for y in [-.0675,.0675]:
   seat=box((0,y,.438),(1,.115,.024),P,.004)
   cutter=box((0,0,.438),(.16,.045,.09),DARK,.02);cut(seat,cutter)
  box((0,0,.096),(.89,.23,.024),P,.004)
  for y in [-.114,.114]:box((0,y,.166),(.89,.022,.13),P,.004)
  for x in [-.46,.46]:
   for y in [-.065,.065]:cylinder((x,y,.450),.003,.001,mat('pine-fixings','#715944'),8)
 elif name=='kirribilli':
  for x in [-.69,.69]:
   for y in [-.91,.91]:cylinder((x,y,.145),.065,.29,P,24)
  box((0,0,.29),(1.56,2.12,.11),P,.047)
  box((0,-1.012,.65),(1.56,.096,.62),P,.04)
  bedding=json.loads((ROOT/'data/bedding.json').read_text())[0]
  cloth=mat('bedding-fabric',bedding['color']);trim=mat('bedding-trim',bedding['trim'])
  box((0,.026,.487),(1.53,2.025,.29),cloth,.06)
  # A tucked duvet with a softly crowned top and curved drops over the mattress edge.
  profile=[(-.77,.47),(-.769,.56),(-.756,.627),(-.72,.654),(-.64,.665),(0,.674),(.64,.665),(.72,.654),(.756,.627),(.769,.56),(.77,.47)]
  verts=[];rows=36
  for j in range(rows+1):
   y=-.38+j*1.39/rows
   for x,z in profile:verts.append((x,y,z+.003*math.sin(j*.7+x*14)))
  n=len(profile);quilt=mesh('Soft tucked linen quilt',verts,[(j*n+i,j*n+i+1,(j+1)*n+i+1,(j+1)*n+i) for j in range(rows) for i in range(n-1)],cloth)
  sub=quilt.modifiers.new('Soft linen folds','SUBSURF');sub.levels=2;bpy.context.view_layer.objects.active=quilt;bpy.ops.object.modifier_apply(modifier=sub.name)
  solid=quilt.modifiers.new('Quilt thickness','SOLIDIFY');solid.thickness=.012;bpy.ops.object.modifier_apply(modifier=solid.name)
  for y in [-.38,1.01]:tube([(x,y,z+.006) for x,z in profile],.005,trim)
  for x in [-.38,.38]:
   pillow=box((x,-.73,.688),(.65,.42,.10),cloth,.048,8)
   tube([(x+px,-.73+py,.685) for px,py in rr(.65,.42,.09,12)+[rr(.65,.42,.09,12)[0]]],.005,trim)
  for o in parts:
   if o.active_material in [cloth,trim]:
    for f in o.data.polygons:f.use_smooth=True
 elif name=='teak-sideboard':
  # Long, shallow 1960s teak veneer cabinet from the listing photographs.
  # The four flush doors and paired vertical finger pulls define the front face.
  teak_dark=mat('teak-recess','#654022');teak_edge=mat('teak-edge','#87502c');teak_light=mat('teak-highlight','#bc7d47')
  box((0,0,.493),(1.785,.397,.568),P,.008,4)
  box((0,0,.782),(1.815,.425,.016),P,.004,3)
  box((0,.205,.211),(1.785,.019,.035),teak_edge,.003,3)
  # Separate veneer leaves preserve the four-door rhythm and narrow shadow gaps.
  door_w=.431
  for x in [-.666,-.222,.222,.666]:box((x,.207,.504),(door_w,.013,.548),P,.004,3)
  for x in [-.444,0,.444]:box((x,.215,.504),(.006,.004,.532),teak_dark,.001,1)
  # Two pairs of rounded recessed pulls. Dark wells sit behind a narrow timber lip.
  for x in [-.505,-.383,.383,.505]:
   box((x,.216,.535),(.030,.006,.102),teak_dark,.013,8)
   box((x-.006,.220,.535),(.005,.003,.078),teak_edge,.002,2)
  # The cabinet sits on four lightly splayed, tapered legs beneath a slim plinth.
  for x in [-.665,.665]:
   for y in [-.135,.135]:
    leg=cone((x,y,.105),.018,.037,.21,teak_edge,32)
    leg.rotation_euler=(math.radians(3)*(1 if y>0 else -1),math.radians(4)*(-1 if x>0 else 1),0)
  # Restrained veneer lines keep the broad front and top from reading as flat plastic.
  for x in [-.76,-.19,.31,.72]:box((x,.218,.505),(.004,.002,.48),teak_light,.001,1)
  for x in [-.61,.08,.58]:box((x,-.025,.791),(.004,.32,.002),teak_edge,.001,1)
 elif name=='dyvlinge':
  # The chair is one upholstered bucket, not separate oval seat and back cushions.
  # This closed side profile follows the listing's low front lip, reclined back,
  # rounded-square crown and fabric-covered sling beneath the seat.
  profile=[
   (-.18,.20,.23),(-.22,.27,.27),(-.22,.53,.285),(-.205,.64,.29),
   (-.17,.68,.275),(-.115,.67,.265),(-.07,.60,.27),(-.035,.49,.285),
   (-.015,.41,.30),(.10,.405,.315),(.24,.425,.315),(.35,.39,.30),
   (.375,.335,.285),(.36,.275,.275),(.25,.235,.265),(.08,.225,.25),
   (-.09,.185,.235),(-.22,.18,.225)
  ]
  across=32;verts=[]
  for i in range(across+1):
   u=-1+2*i/across;rounding=abs(u)**8
   for y,z,w in profile:
    # Pull the outer corners inward so the upholstery has wrapped, padded edges.
    verts.append((w*u,y-rounding*(.014 if y>0 else -.006),z-rounding*(.012 if z>.32 else -.004)))
  n=len(profile);faces=[]
  for i in range(across):
   for j in range(n):faces.append((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j))
  faces.extend([tuple(range(n-1,-1,-1)),tuple(across*n+j for j in range(n))])
  shell=mesh('continuous-upholstered-bucket',verts,faces)
  bevel=shell.modifiers.new('Soft wrapped edges','BEVEL');bevel.width=.009;bevel.segments=3
  bpy.context.view_layer.objects.active=shell;bpy.ops.object.modifier_apply(modifier=bevel.name)
  for face in shell.data.polygons:face.use_smooth=True

  seam=mat('upholstery-seam','#b84f2f')
  tube([(-.285,-.025,.414),(0,-.042,.405),(.285,-.025,.414)],.005, seam)
  # Four back tufts and four seat tufts match the buttoned Kelinge upholstery.
  for x in [-.125,.125]:
   for y,z in [(-.045,.535),(-.075,.615)]:sphere((x,y,z),(.015,.006,.012),seam)
   for y,z in [(.11,.416),(.245,.43)]:sphere((x,y,z),(.015,.010,.009),seam)

  # The chrome swivel assembly remains visible below the fabric-covered sling.
  cylinder((0,0,.14),.028,.20,STEEL,32)
  lathe([(0,.035),(.050,.035),(.055,.075),(.045,.12),(.032,.145),(0,.145)],STEEL,48,'swivel-hub')
  cylinder((0,0,.205),.041,.035,DARK,32)
  for i in range(5):
   a=i*math.tau/5
   tube([(.025*math.cos(a),.025*math.sin(a),.055),(.26*math.cos(a),.26*math.sin(a),.021)],.014,STEEL)
 elif name in {p['id'] for p in PHOTO_SPECS}:
  if spec.get('baseModel'):
   base=next(p for p in SPECS if p['id']==spec['baseModel']);make(base)
  photo_objects.build(spec,box=box,cylinder=cylinder,cone=cone,sphere=sphere,mesh=mesh,tube=tube,lathe=lathe,ring=ring,rr=rr,cut=cut,mat=mat,parts=parts)
 else:raise ValueError(name)

def bounds():
 bpy.context.view_layer.update();points=[o.matrix_world@v.co for o in parts for v in o.data.vertices]
 return [min(p[i] for p in points) for i in range(3)],[max(p[i] for p in points) for i in range(3)]

for spec in SPECS:
 name=spec['id']
 if os.environ.get('APARTMENT_MODELS') and name not in os.environ['APARTMENT_MODELS'].split(','):continue
 for o in parts:bpy.data.objects.remove(o,do_unlink=True)
 parts=[];make(spec)
 if name in {p['id'] for p in PHOTO_SPECS}:
  # Bake rotated parts before nonuniform envelope calibration to avoid shear loss.
  bpy.context.view_layer.update()
  for o in parts:
   o.data.transform(o.matrix_world);o.matrix_world=Matrix.Identity(4)
 for o in parts:
  bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
  bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.normals_make_consistent(inside=False);bpy.ops.object.mode_set(mode='OBJECT')
 # Calibrate photographic reconstruction to the measured envelope, in real metres.
 lo,hi=bounds();scale=Vector((spec['w']/(hi[0]-lo[0]),spec['d']/(hi[1]-lo[1]),spec['h']/(hi[2]-lo[2])))
 trans=Matrix.Diagonal((*scale,1))@Matrix.Translation(Vector((-(hi[0]+lo[0])/2,-(hi[1]+lo[1])/2,-lo[2])))
 for o in parts:o.matrix_world=trans@o.matrix_world
 if name=='dyvlinge':
  # Preserve the catalogue depth after Blender applies the shell's bevel normals.
  correction=Matrix.Translation(Vector((0,0,.0015)))@Matrix.Diagonal((1,1.0041,1,1))
  for o in parts:o.matrix_world=correction@o.matrix_world
 bpy.context.view_layer.update()
 work=ROOT/'runs/furniture'/name;work.mkdir(parents=True,exist_ok=True)
 (work/'request.json').write_text(json.dumps({**spec,'palette':'apartment-fixtures-v2','asymmetry':'All physical faces modelled in 3D; no mirrored raster views','materials':'Semantic finish-primary, fixed metals, diffuser; photo-derived contours','references':[spec.get('photo') or spec['url']]},indent=2)+'\n')
 # Same world handedness / height correction as the existing approved geometry.
 for o in parts:o.matrix_world=Matrix.Diagonal((1,-1,HEIGHT_SCALE,1))@o.matrix_world
 bpy.ops.object.select_all(action='DESELECT')
 for o in parts:o.select_set(True)
 # Save editable separate parts; export glTF with semantic material names.
 bpy.ops.wm.save_as_mainfile(filepath=str(work/f'{name}.blend'))
 if name in photo_objects.room_details.IDS:
  from settle_textiles import freeze_export_modifiers
  freeze_export_modifiers(parts,spec['h']*HEIGHT_SCALE)
 bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();parts=[bpy.context.object];parts[0].name=name
 if name=='orange-cat-clock':photo_objects.clock_morphs(parts[0],HEIGHT_SCALE)
 bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/models'/f'{name}.glb'),export_format='GLB',use_selection=True,export_animations=False,export_cameras=False,export_lights=False)
 print('STAGED',name,flush=True)
manifest=ROOT/'public/models/manifest.json';data=json.loads(manifest.read_text());import hashlib
data['hashes']={p.stem:hashlib.sha256(p.read_bytes()).hexdigest()[:12] for p in sorted((ROOT/'public/models').glob('*.glb'))};data['models']=sorted(data['hashes']);data['version']=3
manifest.write_text(json.dumps(data,indent=2)+'\n')
