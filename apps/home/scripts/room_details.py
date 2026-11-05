"""September 11 photo models. Authoring coordinates are X, depth, height in metres."""
import math,bpy
from mathutils import Vector,Matrix,Euler
from mathutils.bvhtree import BVHTree
from settle_textiles import settle_cloth
IDS={'breville-barista','delonghi-kettle','island-fern','paper-towel','carrot-scratcher','linen-wall-art','numero-high','numero-low','fireside-dressed','dyvlinge-dressed'}

def build(spec, *, box,cylinder,cone,sphere,mesh,tube,lathe,ring,rr,mat,parts):
 name=spec['id'];dark=mat('detail-charcoal','#272d30');silver=mat('detail-chrome','#a8b4b7');cream=mat('detail-cream','#e7e1ce')
 def smooth(o):
  for p in o.data.polygons:p.use_smooth=True
  return o
 def ball(p,s,m):return smooth(sphere(p,s,m))
 def turn(profile,m,label):return smooth(lathe(profile,m,64,label))
 def disc(p,r,d,m):
  o=cylinder(p,r,d,m,48);o.rotation_euler.x=math.pi/2;return o
 def tube(points,r,m):
  # One continuous mesh per seam, not thousands of disconnected cylinders.
  points=[Vector(p) for p in points];vertices=[];segments=8
  for i,p in enumerate(points):
   tangent=(points[min(i+1,len(points)-1)]-points[max(0,i-1)]).normalized()
   axis=Vector((0,0,1)) if abs(tangent.z)<.95 else Vector((1,0,0))
   u=tangent.cross(axis).normalized();v=tangent.cross(u).normalized()
   vertices.extend(tuple(p+r*(u*math.cos(j*math.tau/segments)+v*math.sin(j*math.tau/segments))) for j in range(segments))
  faces=[(i*segments+j,i*segments+(j+1)%segments,(i+1)*segments+(j+1)%segments,(i+1)*segments+j) for i in range(len(points)-1) for j in range(segments)]
  faces.extend([tuple(range(segments-1,-1,-1)),tuple((len(points)-1)*segments+j for j in range(segments))])
  return smooth(mesh('Detail seam',vertices,faces,m))
 def cloth(label,w,path,m,x=0,phase=0):
  # Sample the evaluated seat, including bevels, not a guessed plane through it.
  bpy.context.view_layer.update();deps=bpy.context.evaluated_depsgraph_get();supportverts=[];supportfaces=[]
  for o in [o for o in parts if any(m.name.startswith(('numero-fabric','finish-primary')) for m in o.data.materials)]:
   evaluated=o.evaluated_get(deps);data=evaluated.to_mesh();offset=len(supportverts)
   supportverts.extend(o.matrix_world@v.co for v in data.vertices);supportfaces.extend(tuple(offset+i for i in p.vertices) for p in data.polygons);evaluated.to_mesh_clear()
  support=BVHTree.FromPolygons(supportverts,supportfaces)
  path=[(a[0]+(b[0]-a[0])*k/6,a[1]+(b[1]-a[1])*k/6) for a,b in zip(path,path[1:]) for k in range(6)]+[path[-1]]
  verts=[];nx=48;ny=len(path)
  for j,(y,z) in enumerate(path):
   for i in range(nx+1):
    u=i/nx;wave=math.sin(u*math.pi*8+phase+j*.10)
    p=Vector((x+(u-.5)*w*(.95+.05*math.sin(j*.25)),y+.010*wave,z+.018*wave*math.sin(math.pi*u)+.008*math.sin(j*.3+u*9)))
    if z<.32:
     hit=support.ray_cast(Vector((p.x,5,p.z)),Vector((0,-1,0)))[0]
     if hit:p.y=max(p.y,hit.y+.030)
    hit=support.ray_cast(Vector((p.x,p.y,5)),Vector((0,0,-1)))[0]
    if hit:p.z=max(p.z,hit.z+.028+.018*(wave*.5+.5)*math.sin(math.pi*u))
    verts.append(tuple(p))
  faces=[(j*(nx+1)+i,j*(nx+1)+i+1,(j+1)*(nx+1)+i+1,(j+1)*(nx+1)+i) for j in range(ny-1) for i in range(nx)]
  # At the lip, two clear vertices can still bridge through the curved foam.
  # Wrap those panels forward around the lip rather than slicing its corner.
  for _ in range(8):
   corrections=0
   for face in faces:
    centre=sum((Vector(verts[i]) for i in face),Vector())/4
    hit=support.ray_cast(Vector((centre.x,centre.y,5)),Vector((0,0,-1)))[0]
    if hit and hit.z>centre.z-.006:
     front=support.ray_cast(Vector((centre.x,5,centre.z)),Vector((0,-1,0)))[0]
     for i in face:
      p=Vector(verts[i])
      if front:p.y=max(p.y,front.y+.023)
      else:p.z=max(p.z,hit.z+.025)
      verts[i]=tuple(p)
     corrections+=1
   if not corrections:break
  o=mesh(label,verts,faces,m)
  verts=settle_cloth(o,supportverts,supportfaces,nx+1)
  o.modifiers.new('Woven thickness','SOLIDIFY').thickness=.006;smooth(o)
  thread=mat('textile-thread-'+label,'#efc7c7' if 'blush' in label else '#c9b7a3' if 'cream' in label else '#a44d32')
  for i in range(0,nx+1,2):tube([verts[j*(nx+1)+i] for j in range(ny)],.0009,thread)
  for i in [0,nx]:tube([verts[j*(nx+1)+i] for j in range(ny)],.003,m)
 def cushion(x,y,z,size=.33,kind='stripe',lean=38):
  start=len(parts)
  purple=mat('cushion-purple','#573455');gold=mat('cushion-gold','#c59c44');rose=mat('cushion-rose','#b16b83')
  # Two convex cloth faces meet at a pinched, piped perimeter.
  def surface(u,v,side=1):
   bulge=max(0,math.cos(u*math.pi)*math.cos(v*math.pi))**.55
   return (x+u*size*(1-.09*(abs(v)*2)**10),y+side*(.008+.062*bulge),z+v*size*(1-.09*(abs(u)*2)**10))
  n=24;verts=[surface(i/n-.5,j/n-.5,side) for side in [-1,1] for j in range(n+1) for i in range(n+1)];band=(n+1)**2
  faces=[]
  for side in range(2):
   for j in range(n):
    for i in range(n):
     a=side*band+j*(n+1)+i;faces.append((a,a+1,a+n+2,a+n+1))
  edge=list(range(n+1))+[j*(n+1)+n for j in range(1,n+1)]+[n*(n+1)+i for i in range(n-1,-1,-1)]+[j*(n+1) for j in range(n-1,0,-1)]
  for a,b in zip(edge,edge[1:]+edge[:1]):faces.append((a,b,b+band,a+band))
  body=smooth(mesh('Soft cushion',verts,faces,purple))
  tube([(verts[i][0],y,verts[i][2]) for i in edge+[edge[0]]],.002,gold)
  for j in range(7):
   pts=[]
   for i in range(19):
    t=i/18;u=(j/6-.5)*.86+.026*math.sin(t*8+j);v=(t-.5)*.90
    px,py,pz=surface(u,v);pts.append((px,py+.002,pz))
   tube(pts,.0035,[gold,rose,rose,gold,cream,gold,rose][j])
  if kind=='circle':
   for dx,dz in [(-.07,.07),(.06,-.06),(.08,.085),(-.07,-.06)]:
    tube([surface((dx+.027*math.cos(a*math.tau/24))/size,(dz+.027*math.sin(a*math.tau/24))/size) for a in range(25)],.004,cream)
  bpy.context.view_layer.update();centre=Vector((x,y,z));transform=Matrix.Translation(centre)@Euler((math.radians(lean),math.radians(-9),math.radians(-6))).to_matrix().to_4x4()@Matrix.Translation(-centre)
  for o in parts[start:]:o.matrix_world=transform@o.matrix_world
 if name=='breville-barista':
  metal=mat('espresso-dark-steel','#424e56');black=mat('espresso-black','#171e22')
  box((.075,0,.045),(.33,.35,.07),metal,.018,6)
  box((.075,-.112,.20),(.32,.10,.32),metal,.015,6)
  for x in [-.069,.219]:box((x,.025,.175),(.039,.29,.23),metal,.012,5)
  box((.075,.005,.293),(.34,.32,.102),metal,.014,6)
  box((.075,.17,.293),(.326,.009,.083),black,.01,5)
  box((.075,.032,.084),(.286,.286,.012),silver,.005)
  for y in [-.075+i*.018 for i in range(13)]:box((.075,y,.092),(.271,.006,.003),black,.001)
  disc((.075,.179,.279),.026,.006,silver);disc((.075,.183,.279),.022,.003,cream)
  tube([(.075,.187,.279),(.087,.187,.293)],.0018,mat('gauge-needle','#9e4538'))
  for x in [-.060,-.022,.016,.132,.17,.208]:
   disc((x,.179,.310),.013,.005,silver);disc((x,.183,.310),.010,.002,mat('button-blue','#8ec2ce'))
  for x in [-.015,.132]:cylinder((x,.085,.22),.036,.026,silver,32)
  cylinder((.13,.10,.207),.03,.018,black,32)
  tube([(.13,.105,.207),(.13,.27,.179)],.015,black)
  disc((.13,.271,.179),.013,.008,silver)
  tube([(.236,.10,.24),(.263,.13,.225),(.265,.15,.105)],.006,silver)
  ball((.25,.13,.221),(.018,.015,.012),black)
  cylinder((-.003,-.048,.36),.081,.015,black,48)
  turn([(0,.34),(.055,.34),(.082,.37),(.084,.402),(.080,.408),(0,.408)],mat('hopper-smoked','#263238'),'Bean hopper').location.x=-.003
  cylinder((-.003,0,.410),.087,.009,silver,64)
  # Little dosing cup on the warming tray.
  turn([(.026,.347),(.03,.353),(.031,.372),(.027,.372),(.025,.353)],silver,'Dosing cup').location.x=.165
  for i in range(8):box((.145,-.07+i*.018,.347),(.12,.006,.005),black,.001)
  turn([(0,0),(.060,0),(.064,.014),(.047,.13),(.045,.18),(.040,.18),(.041,.133),(.056,.02),(0,.02)],black,'Open knock box').location.x=-.18
  tube([(-.234,0,.15),(-.126,0,.15)],.004,silver)
 elif name=='delonghi-kettle':
  blue=mat('kettle-blue','#47788e')
  turn([(0,0),(.078,0),(.087,.01),(.087,.025),(.078,.04),(.092,.063),(.085,.11),(.065,.20),(.042,.249),(0,.249)],blue,'Tapered blue kettle')
  for z,r in [(.048,.087),(.066,.090),(.246,.044)]:turn([(r-.002,z-.003),(r+.001,z),(r-.002,z+.003)],silver,'Chrome band')
  cone((0,0,.256),.05,.015,.022,silver,64);ball((0,0,.278),(.010,.010,.012),blue)
  tube([(.045,-.008,.235),(.10,-.008,.218),(.12,-.008,.09),(.09,-.008,.072)],.013,blue)
  # Open triangular metal spout on the opposite side of the handle.
  mesh('Kettle spout',[(-.059,-.024,.205),(-.115,-.018,.233),(-.115,.018,.233),(-.059,.024,.205),(-.065,0,.162)],[(0,1,2,3),(0,4,1),(1,4,2),(2,4,3)],silver)
  box((.085,.03,.055),(.026,.014,.010),blue,.004)
 elif name=='paper-towel':
  turn([(.016,0),(.051,0),(.052,.235),(.049,.24),(.016,.24),(.016,0)],cream,'Paper towel hollow roll')
  turn([(.016,0),(.019,0),(.019,.238),(.016,.238)],mat('paper-core','#a9987d'),'Cardboard core')
  for i in range(48):turn([(.052,.005+i*.0048),(.0525,.006+i*.0048),(.052,.007+i*.0048)],mat('paper-rib','#d2cbb8'),'Embossed paper rib')
 elif name=='island-fern':
  terracotta=mat('fern-pot','#885641');green=mat('fern-frond','#527d55')
  turn([(0,0),(.083,0),(.099,.014),(.092,.026),(.10,.178),(.094,.19),(.087,.19),(.087,.028),(0,.026)],terracotta,'Terracotta pot')
  cylinder((0,0,.176),.086,.006,mat('soil','#30291f'),40)
  for j in range(9):
   a=j*2.399;tip=Vector((.06*math.cos(a),.06*math.sin(a),.28+j%3*.045));start=Vector((0,0,.178))
   tube([start,tip],.0018,mat('fern-stem','#78915c'));verts=[]
   direction=Vector((.13*math.cos(a),.13*math.sin(a),.18 if j<6 else -.12));side=Vector((-math.sin(a),math.cos(a),0))
   for i in range(25):
    t=i/24;c=tip+direction*t;lobe=.034*math.sin(math.pi*t)**.6*(.48+.52*math.cos(t*math.pi*10)**4)
    for k in [-1,0,1]:verts.append(tuple(c+side*k*lobe+Vector((0,0,abs(k)*.006*math.sin(t*18)))))
   o=mesh('Lobed fern leaf',verts,[(i*3+k,i*3+k+1,(i+1)*3+k+1,(i+1)*3+k) for i in range(24) for k in range(2)],green);o.modifiers.new('Leaf thickness','SOLIDIFY').thickness=.001
   tube([verts[i*3+1] for i in range(25)],.0008,mat('fern-vein','#7b9765'))
 elif name=='carrot-scratcher':
  orange=mat('carrot-rope','#e87515');green=mat('carrot-fleece','#8caa42')
  turn([(0,0),(.185,0),(.20,.012),(.198,.028),(.18,.043),(0,.043)],green,'Green circular carpet base')
  profile=[(.032,.04),(.043,.09),(.058,.26),(.077,.44),(.079,.48),(.067,.52),(.039,.54)]
  turn([(0,.04),*profile,(0,.54)],orange,'Tapered rope carrot')
  for i in range(92):
   z=.045+i*.0053;r=next((ra+(rb-ra)*(z-za)/(zb-za) for (ra,za),(rb,zb) in zip(profile,profile[1:]) if za<=z<=zb),.038)
   turn([(r,z),(r+.0018,z+.001),(r,z+.0028)],mat('rope-ridge','#c96319'),'Sisal winding')
  for j in range(7):
   a=j*math.tau/7;length=.16 if j%2 else .23;end=Vector((math.cos(a)*length*.62,math.sin(a)*length*.62,.55+length*(.75 if j%3 else 1)))
   o=ball(tuple((Vector((0,0,.535))+end)/2),(.018,.013,(end-Vector((0,0,.535))).length/2),green);o.rotation_euler=(end-Vector((0,0,.535))).to_track_quat('Z','Y').to_euler()
 elif name=='linen-wall-art':
  box((0,0,.20),(.30,.016,.40),cream,.001)
  ink=mat('canvas-ink','#27272b');ball((0,.010,.15),(.033,.001,.086),ink)
  for side in [-1,1]:
   tube([(0,.012,.18),(side*.064,.012,.075),(side*.058,.012,.025),(side*.025,.012,.030)],.008,ink)
   for j in range(3):
    x=side*(.045+j*.027);z=.18+j*.064;tube([(0,.012,.20),(x,.012,z),(x,.012,z+.042)],.007,ink)
    ball((x,.012,z+.042),(.020,.002,.027),ink)
    for dx in [-.006,.006]:mesh('Tiny pale eye',[(x+dx-.003,.015,z+.045),(x+dx+.003,.015,z+.045),(x+dx,.015,z+.037)],[(0,1,2)],cream)
  for j in range(36):
   x=-.137+(j%9)*.034;z=.023+(j//9)*.10
   tube([(x+.005*math.sin(k+j),.010,z+k*.009) for k in range(7)],.0019,ink)
 elif name in ['numero-high','numero-low']:
  high=name=='numero-high';h=.864 if high else .622;depth=.81 if high else .75
  fabric=mat('numero-fabric','#849d3c' if high else '#32788a')
  # One moulded seat/back volume. No arms, legs, separate stacked cushions or tape.
  profile=[(-depth/2,.045),(-depth/2,h-.055),(-depth/2+.075,h),(-depth/2+.145,h-.035),(-.17,.47 if high else .43),(-.05,.31),(.16,.32),(depth/2-.025,.36),(depth/2,.30),(depth/2-.005,.09),(depth/2-.055,.018),(-.25,.018)]
  path=[]
  for j in range(len(profile)):
   a,b,c,d=[Vector(profile[(j+k)%len(profile)]) for k in [-1,0,1,2]]
   for k in range(6):
    t=k/6;p=.5*(2*b+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t);path.append(p)
  n=len(path);verts=[];nx=48
  for i in range(nx+1):
   x=(i/nx-.5)*.762;edge=(abs(x)/.381)**10
   for p in path:verts.append((x,p.x*(1-.10*edge),.29+(p.y-.29)*(1-.12*edge)))
  faces=[(i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j) for i in range(nx) for j in range(n)]
  faces.extend([tuple(range(n-1,-1,-1)),tuple(nx*n+j for j in range(n))]);body=smooth(mesh('Continuous Numero moulding',verts,faces,fabric))
  bevel=body.modifiers.new('Soft foam perimeter','BEVEL');bevel.width=.028;bevel.segments=4
  def drape(samples):
   result=[]
   for y,z in samples:
    intersections=[a.y+(b.y-a.y)*(y-a.x)/(b.x-a.x) for a,b in zip(path,path[1:]+path[:1]) if min(a.x,b.x)<=y<=max(a.x,b.x) and abs(b.x-a.x)>.00001]
    result.append((y,max(z,max(intersections)+.025) if intersections else z))
   return result
  if high:
   o=box((0,-.195,.752),(.38,.065,.15),fabric,.042,8);o.rotation_euler.x=math.radians(-12)
   cloth('rust-throw',.47,drape([(-.12,.42),(-.05,.37),(.015,.35),(.10,.36),(.17,.39),(.25,.36),(.32,.35),(.41,.26),(.42,.13),(.42,.035)]),mat('rust-knit','#a44d32'),x=.11)
   cushion(-.10,-.02,.475,.30,'circle',38)
  else:cloth('cream-throw',.51,drape([(-.31,.64),(-.25,.63),(-.19,.53),(-.12,.43),(-.05,.35),(.06,.35),(.15,.38),(.25,.37),(.32,.33),(.395,.24),(.405,.13),(.405,.045)]),cream,x=-.035)
 elif name=='fireside-dressed':
  cloth('blush-throw',.88,[(-.11,.39),(.04,.47),(.19,.48),(.34,.49),(.47,.48),(.55,.43),(.57,.25),(.56,.06)],mat('blush-knit','#efc7c7'),x=-.35,phase=.6)
  cushion(.24,-.075,.443,.34,lean=48)
 elif name=='dyvlinge-dressed':
  start=len(parts)
  brown=mat('flower-plush','#44352e')
  for j in range(6):
   a=j*math.tau/6;o=ball((.105*math.sin(a),-.008,.568+.105*math.cos(a)),(.062,.036,.089),brown);o.rotation_euler.y=-a
  ball((0,.015,.568),(.057,.040,.056),brown)
  ball((0,.052,.575),(.046,.013,.030),cream);ball((.007,.063,.575),(.022,.006,.026),dark)
  bpy.context.view_layer.update();centre=Vector((0,.01,.568))
  transform=Matrix.Translation(centre+Vector((0,.025,.025)))@Matrix.Rotation(math.radians(28),4,'X')@Matrix.Translation(-centre)
  for o in parts[start:]:o.matrix_world=transform@o.matrix_world
