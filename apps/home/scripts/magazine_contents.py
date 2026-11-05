"""Paper geometry stays opaque inside the independently transparent rack pockets."""
import bpy,math

def fill_rack(*,box,mesh,mat,parts):
 paper=mat('magazine-pages','#e7dfcb');ink=mat('magazine-ink','#272d30')
 colors=['#e7dfcb','#418a99','#be4d3b','#d0a151','#bd9a36','#e3b854','#547d91','#ede4d0']
 for row,y in enumerate([.069,.023,-.023,-.069]):
  for side,x in enumerate([-.096,.096]):
   index=row*2+side;bottom=.009 if row in [0,3] else .074
   h=.287+(index%3)*.018;w=.176;front=y+.009
   cover=mat('magazine-cover-'+str(index),colors[index]);accent=mat('magazine-accent-'+str(index),['#b05a78','#d6ad47','#388d94','#573455'][index%4])
   box((x,y,bottom+h/2),(w,.014,h),paper,.001)
   for offset in [-.008,.008]:box((x,y+offset,bottom+h/2),(w+.003,.0015,h+.002),cover,0)
   for line in range(6):box((x+w/2+.001,y,bottom+.012+line*(h-.025)/6),(.001,.013,.0007),mat('page-edge','#b8ad97'),0)
   title='POPEYE' if index==0 else 'PLAYBOY' if index<6 else 'ART'
   font=bpy.data.curves.new('Magazine masthead','FONT');font.body=title;font.align_x='CENTER';font.size=.031;font.extrude=.0001
   obj=bpy.data.objects.new('Printed '+title,font);bpy.context.collection.objects.link(obj);obj.location=(x,front+.001,bottom+h-.033);obj.rotation_euler.x=math.pi/2
   obj.data.materials.append(ink)
   bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj;bpy.ops.object.convert(target='MESH');parts.append(bpy.context.object)
   # Original simplified cover graphics, not photographic reproductions.
   if index%2:
    mesh('Graphic cover',[(x-.07,front+.001,bottom+.05),(x+.068,front+.001,bottom+.05),(x+.06,front+.001,bottom+h-.049),(x-.063,front+.001,bottom+h-.08)],[(0,1,2,3)],accent)
   else:
    for j in range(4):
     box((x-.055+j*.036,front+.001,bottom+.09+.027*math.sin(j*2)),(.028,.001,.08+.017*(j%2)),accent,.004)
   for j in range(3):box((x-.015,front+.002,bottom+.018+j*.007),(.12-j*.025,.001,.002),ink,0)
