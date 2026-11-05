import initialPublic from './public-view/initial-layout.json';
import {simulatedLights} from './public-view/lighting';
import {apartmentSunlight} from './public-view/daylight';
import {afterAll,beforeAll,expect,test,spyOn} from 'bun:test';
import {NullEngine} from '@babylonjs/core/Engines/nullEngine';
import {Vector3} from '@babylonjs/core/Maths/math.vector';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial';
import {ApartmentWorld,configureCamera,projectedWorld,type WorldOptions} from './worldScene';
import {CATALOG,parseItems,type Item} from './editorState';
import {HEIGHT_SCALE,SHADOW_LAYER,CAMERA_LAYER} from './worldShell';
import {project,DEFAULT_WALL_DISPLAY} from './scene';
import {DEFAULT_ENVIRONMENT,sceneLights,sunlight} from './lighting';
import {lightState,type Hass} from './ha';
import {kelvinColor} from './lightColor';
import photoObjects from '../data/photo-objects.json';
import {MirrorTexture} from '@babylonjs/core/Materials/Textures/mirrorTexture';
let engine:NullEngine,world:ApartmentWorld;
const hass:Hass={states:{'sun.sun':{entity_id:'sun.sun',state:'above_horizon',attributes:{elevation:40,azimuth:41}},'light.lamp':{entity_id:'light.lamp',state:'on',attributes:{brightness:128,color_temp_kelvin:2700}}},callService:async()=>{throw Error('Rendering must never call a real light service');}};
const options:WorldOptions={q:0,items:[{id:'lamp',productId:'okensand',x:2.5,z:3.5,rotation:0,entityId:'light.lamp'}],selected:null,ghost:null,grid:false,labels:false,walls:'cutaway',fittings:true,cats:[],frame:0,hass,devices:false,vacuum:null,environment:DEFAULT_ENVIRONMENT};
beforeAll(async()=>{
 engine=new NullEngine({renderWidth:960,renderHeight:720,textureSize:512,deterministicLockstep:false,lockstepMaxSteps:4});world=new ApartmentWorld(engine);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const name=new URL(req.url).pathname.split('/').at(-1);return new Response(Bun.file(new URL('../public/models/'+name,import.meta.url)));}});
 try{await world.load(`http://127.0.0.1:${server.port}`);}finally{server.stop(true);}
});
afterAll(()=>{world.dispose();engine.dispose();});
test('Custom finishes stay per item and clear pockets retain opaque magazine covers',()=>{
 const plain:import('./editorState').Item={id:'custom-rack',productId:'magazine-rack',x:2,z:3,rotation:0,entityId:'',finish:'clear'};
 const rack={...plain,materialColor:'#cc6633',materialGloss:.8};
 world.update({...options,items:[rack,{...plain,id:'plain-rack',x:3}]});
 const material=(id:string,key:string)=>world.scene.meshes.find(m=>m.name.startsWith(id+'/')&&m.material?.name.includes(key))?.material;
 const plastic=material(rack.id,'finish-primary'),cover=material(rack.id,'magazine-cover'),other=material('plain-rack','finish-primary');
 if(!(plastic instanceof StandardMaterial)||!(cover instanceof StandardMaterial)||!(other instanceof StandardMaterial))throw Error('Missing rack materials');
 expect(plastic.diffuseColor.toHexString()).toBe('#CC6633');expect(plastic.alpha).toBeCloseTo(.08);expect(plastic.specularColor.r).toBeCloseTo(.64);expect(cover.alpha).toBe(1);expect(other.diffuseColor.toHexString()).toBe('#D6E8E6');
 world.update({...options,items:[plain]});expect(plastic.diffuseColor.toHexString()).toBe('#D6E8E6');expect(plastic.specularPower).toBe(64);
});
test('Leaning mirror reflection plane follows all four object rotations',()=>{
 for(const rotation of [0,1,2,3] satisfies (0|1|2|3)[]){
  world.update({...options,items:[{id:'leaner',productId:'ikornnes',x:3,z:4,rotation,entityId:''}]});
  const glass=world.scene.meshes.find(m=>m.name.startsWith('leaner/')&&m.material?.name.includes('mirror-silver'));
  if(!glass||!(glass.material instanceof StandardMaterial)||!(glass.material.reflectionTexture instanceof MirrorTexture))throw Error('Missing real mirror');
  const mirror=glass.material.reflectionTexture;
  const backing=world.scene.meshes.find(m=>m.name.startsWith('leaner/')&&m.material?.name.includes('mirror-back'));
  if(!backing)throw Error('Missing mirror backing');
  expect(mirror.mirrorPlane.signedDistanceTo(backing.getBoundingInfo().boundingBox.centerWorld)).toBeGreaterThan(0);
  expect(Math.abs(mirror.mirrorPlane.signedDistanceTo(glass.getBoundingInfo().boundingBox.centerWorld))).toBeLessThan(.001);
  expect(mirror.renderList?.includes(glass)).toBe(false);expect(mirror.getSize().width).toBe(512);
 }
});
test('Babylon camera matches saved floor coordinates and height projection in all four views',()=>{
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  configureCamera(world.camera,q);world.scene.render();
  for(const p of [{x:0,z:1.5,h:0},{x:7,z:2,h:1.2},{x:5.1,z:1.325,h:2.4}]){
   const actual=projectedWorld(world.camera,new Vector3(p.x,p.h*HEIGHT_SCALE,p.z)),expected=project(p,q,p.h);
   expect(Math.abs(actual.x-expected.x)).toBeLessThan(1);expect(Math.abs(actual.y-expected.y)).toBeLessThan(1);
  }
 }
});
test('HA lights change scene intensity, colour, shadows and off state without device writes',()=>{
 world.update(options);const source=world.sources.get('lamp');expect(source).toBeDefined();expect(source?.light.intensity).toBeCloseTo(128/255*.8/3);
 expect(source?.light.diffuse.r).toBeGreaterThan(source?.light.diffuse.b??1);
 expect(source?.shadow.getShadowMap()?.renderList?.some(m=>m.name.startsWith('wall-shadow'))).toBe(true);
 expect(source?.shadow.getShadowMap()?.renderList?.some(m=>m.name.startsWith('lamp/'))).toBe(false);
 world.update({...options,hass:{...hass,states:{...hass.states,'light.lamp':{entity_id:'light.lamp',state:'off',attributes:{brightness:255}}}}});
 expect(source?.light.intensity).toBe(0);expect(source?.light.isEnabled()).toBe(false);
 world.update({...options,hass:undefined});expect(source?.light.isEnabled()).toBe(false);
});
test('North-east balcony alignment, twilight and night use sun position',()=>{
 const day=sunlight(hass,DEFAULT_ENVIRONMENT);expect(day.source).toBe('home-assistant');expect(day.direction.x).toBeCloseTo(0);expect(day.direction.z).toBeGreaterThan(0);
 const night=sunlight(undefined,{...DEFAULT_ENVIRONMENT,mode:'night'});expect(night.direct).toBe(0);expect(night.daylight).toBe(0);
 world.update({...options,environment:{...DEFAULT_ENVIRONMENT,mode:'night'}});expect(world.sun.intensity).toBe(0);expect(world.sky.intensity).toBeLessThan(.2);
});
test('Measured balcony sun matches in dashboard and website through all four camera views',()=>{
 const measured=apartmentSunlight(new Date('2026-09-11T09:00:00+10:00'));
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  world.update({...options,q,sunlight:measured});
  const dashboard=world.sun.direction.clone(),intensity=world.sun.intensity;
  expect(dashboard.x).toBeCloseTo(measured.direction.x);
  expect(dashboard.y).toBeCloseTo(measured.direction.y);
  expect(dashboard.z).toBeCloseTo(measured.direction.z);
  world.update({...options,q,hass:undefined,sunlight:measured});
  expect(world.sun.direction.equals(dashboard)).toBe(true);
  expect(world.sun.intensity).toBe(intensity);
 }
});
test('Public sunlight updates the shared renderer without HA and themes only change the backdrop',()=>{
 const morning=apartmentSunlight(new Date('2026-09-10T09:00:00+10:00'));
 const afternoon=apartmentSunlight(new Date('2026-09-10T15:00:00+10:00'));
 world.update({...options,hass:undefined,sunlight:morning,background:'light'});
 expect(world.sun.intensity).toBeGreaterThan(0);expect(world.scene.clearColor.r).toBe(1);
 const direction=world.sun.direction.clone();
 world.update({...options,hass:undefined,sunlight:afternoon,background:'light'});
 expect(world.sun.direction.equals(direction)).toBe(false);
 const intensity=world.sun.intensity;
 world.update({...options,hass:undefined,sunlight:afternoon,background:'dark'});
 expect(world.scene.clearColor.r).toBe(0);expect(world.sun.intensity).toBe(intensity);
 world.update({...options,hass:undefined,sunlight:apartmentSunlight(new Date('2026-09-10T20:00:00+10:00')),background:'dark'});
 expect(world.sun.intensity).toBe(0);
});
test('Touch presentation pauses GPU work and resumes the latest scene without losing updates',()=>{
 world.update(options);world.render(1000);
 const draw=spyOn(world.scene,'render');
 try{
  world.setPresentationPaused(true);
  world.update({...options,environment:{...DEFAULT_ENVIRONMENT,mode:'night'}});
  world.render(1100);world.render(1200);
  expect(draw).not.toHaveBeenCalled();
  world.setPresentationPaused(false);world.render(1300);
  expect(draw).toHaveBeenCalledTimes(1);expect(world.sun.intensity).toBe(0);
 }finally{world.setPresentationPaused(false);draw.mockRestore();}
});
test('Every cat pose is a real morph target on a mesh that receives and casts light',()=>{
 world.update({...options,cats:[{id:'pearl',x:2,z:3,height:.77,direction:1,animation:'sleep',frame:2}]});
 const meshes=world.scene.meshes.filter(m=>m.name.startsWith('pet/pearl/')&&m.getTotalVertices()>0);expect(meshes.length).toBeGreaterThan(0);
 const managers=world.scene.morphTargetManagers.filter(m=>m.getTargetByName('sleep_2')?.influence===1);
 expect(managers.length).toBeGreaterThan(0);expect(meshes.every(m=>m.receiveShadows)).toBe(true);
});
test('A bound lamp supersedes its estimated ceiling marker, and preview never overrides Live',()=>{
 const id='light.example_living_downlight_1';const items=[{id:'placed',productId:'okensand',x:2,z:3,rotation:0,entityId:id}] satisfies typeof options.items;
 const live=sceneLights(items,undefined,{...DEFAULT_ENVIRONMENT,previewLights:true});expect(live.filter(l=>l.entityId===id).length).toBe(3);expect(live.every(l=>l.brightness===0)).toBe(true);
 const preview=sceneLights(items,undefined,{...DEFAULT_ENVIRONMENT,mode:'night',previewLights:true});expect(preview.every(l=>l.brightness>0&&l.preview)).toBe(true);
});
test('Colour temperature is continuous and malformed brightness cannot illuminate the room',()=>{
 expect(kelvinColor(2200)[2]).toBeLessThan(kelvinColor(4000)[2]);expect(kelvinColor(4000)[2]).toBeLessThan(kelvinColor(6500)[2]);
 expect(lightState({entity_id:'light.x',state:'on',attributes:{brightness:NaN}}).brightness).toBe(0);
 expect(lightState({entity_id:'light.x',state:'on',attributes:{color_mode:'color_temp',color_temp_kelvin:2700,rgb_color:[0,0,255]}}).color).toBe('rgb('+kelvinColor(2700).join(',')+')');
});

test('3D picking selects the upper geometry of a placed lamp in every camera view',()=>{
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  world.update({...options,q});world.render();
  const screen=project({x:2.5,z:3.5},q,1.3);
  expect(world.pickItem(screen.x,screen.y)).toBe('lamp');
 }
});

test('Only the lampshade glows, following brightness and extinguishing when off',()=>{
 world.update(options);
 const materials=world.scene.meshes.filter(m=>m.name.startsWith('lamp/')).map(m=>m.material).filter(m=>m instanceof StandardMaterial);
 const shade=materials.find(m=>m.name.includes('lamp-diffuser-')),wood=materials.find(m=>m.name.includes('#d6a36b'));
 expect(shade?.emissiveColor.r).toBeGreaterThan(.25);expect(shade?.emissiveColor.r).toBeLessThan(.5);expect(wood?.emissiveColor.r).toBe(0);
 world.update({...options,hass:undefined});expect(shade?.emissiveColor.r).toBe(0);
});

test('ÖKENSAND has three interior emitters and a tall, open tapered pleated shade',()=>{
 world.update(options);world.render();
 const lights=sceneLights(options.items,hass,DEFAULT_ENVIRONMENT).filter(l=>l.ownerId==='lamp');
 expect(lights.map(l=>l.height)).toEqual([.52,.9,1.28]);expect(lights.reduce((n,l)=>n+(l.power??1),0)).toBeCloseTo(1);
 const shadeMeshes=world.scene.meshes.filter(m=>m.name.startsWith('lamp/')&&m.material?.name.includes('lamp-diffuser-'));
 expect(shadeMeshes.length).toBe(24);
 const points=shadeMeshes.flatMap(m=>{const v=m.getVerticesData('position')??[];const points:Vector3[]=[];for(let i=0;i<v.length;i+=3)points.push(Vector3.TransformCoordinates(new Vector3(v[i]??0,v[i+1]??0,v[i+2]??0),m.getWorldMatrix()));return points;});
 expect(Math.max(...points.map(p=>p.y))/HEIGHT_SCALE).toBeCloseTo(1.54,2);
 expect(Math.min(...points.map(p=>p.y))/HEIGHT_SCALE).toBeCloseTo(.27,2);
});

test('Full walls restore every wall and upper fitting in every view',()=>{
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  world.update({...options,q,walls:'cutaway'});
  world.update({...options,q,walls:'full'});world.render();
  const walls=world.scene.meshes.filter(m=>/^wall-\d+$/.test(m.name));
  expect(walls.length).toBeGreaterThan(0);
  expect(walls.every(m=>m.isEnabled()&&m.scaling.y===1)).toBe(true);
  const overheads=world.scene.meshes.filter(m=>m.name.startsWith('fixed/overheads/'));
  expect(overheads.length).toBeGreaterThan(0);
  expect(overheads.every(m=>m.isEnabled()&&m.layerMask===1)).toBe(true);
 }
 world.update({...options,walls:'hidden'});
 expect(world.scene.meshes.filter(m=>/^wall-\d+$/.test(m.name)).every(m=>!m.isEnabled())).toBe(true);
});

test('Entry door assembly and its rack follow exterior cutaway in every view and wall mode',()=>{
 const rack:Item={id:'entry-rack',productId:'hang-it-all',x:4.1,z:7.23,rotation:2,entityId:'',elevation:1.55};
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  for(const walls of ['cutaway','full','hidden','low'] satisfies readonly WorldOptions['walls'][]){
   world.update({...options,q,walls,items:[rack]});
   const entry=world.scene.meshes.filter(m=>m.name.startsWith('entry-')&&!m.name.startsWith('entry-rack/'));
   expect(entry.length).toBe(7);
   for(const mesh of entry){
    const visible=walls==='full'||walls==='cutaway'&&(q===1||q===2)||walls==='low'&&(mesh.name==='entry-jamb'||mesh.name==='entry-door-rack-backing');
    expect(mesh.isEnabled(),mesh.name+'/'+q+'/'+walls).toBe(visible);
   }
   const rackMeshes=world.scene.meshes.filter(m=>m.name.startsWith('entry-rack/'));
   expect(rackMeshes.length).toBeGreaterThan(0);
   expect(rackMeshes.every(m=>m.layerMask===1)).toBe(walls==='full'||walls==='cutaway'&&(q===1||q===2));
  }
 }
});

test('The integrated fridge and pantry enclosure reaches the 2.7 m ceiling',()=>{
 world.update(options);world.render();
 const meshes=world.scene.meshes.filter(m=>m.name.startsWith('fixed/kitchen-run/'));
 const heights=meshes.flatMap(m=>{const v=m.getVerticesData('position')??[];const heights:number[]=[];for(let i=0;i<v.length;i+=3)heights.push(Vector3.TransformCoordinates(new Vector3(v[i]??0,v[i+1]??0,v[i+2]??0),m.getWorldMatrix()).y/HEIGHT_SCALE);return heights;});
 expect(Math.max(...heights)).toBeCloseTo(2.7,2);
});

test('Marked perimeter returns cut away together while the balcony divider stays solid',()=>{
 const cases=[
  {name:'entry step beside kitchen',x:0,z:5.9,visible:[false,true,false,false]},
  {name:'entry return beside sideboard',x:.6,z:5.9,visible:[false,true,false,false]},
  {name:'entry door left reveal',x:3.65,z:7.1,visible:[false,true,true,false]},
  {name:'entry door right reveal',x:4.6,z:7.1,visible:[false,true,true,false]},
  {name:'bathroom return short end',x:6.3,z:4.85,visible:[false,true,false,false]},
  {name:'bathroom return beside vanity',x:6.3,z:5.05,visible:[false,true,false,false]},
  {name:'utility front wall',x:4.8,z:5.05,visible:[false,false,true,false]},
  {name:'utility cupboard front',x:5.8,z:5.05,visible:[false,false,true,false]},
  {name:'entry cupboard doors',x:4.8,z:5.65,visible:[false,false,true,false]},
 ];
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  world.update({...options,q});
  const divider=world.shell.walls.filter(p=>p.wall.a.x===4.8&&p.wall.a.z===0&&p.wall.b.z===4);
  expect(divider.length).toBeGreaterThan(0);
  for(const part of divider)expect(part.mesh.isEnabled(),'green balcony divider/'+q).toBe(true);
  for(const fixture of cases){
   const parts=world.shell.walls.filter(p=>p.wall.a.x===fixture.x&&p.wall.a.z===fixture.z);
   expect(parts.length,fixture.name).toBeGreaterThan(0);
   for(const part of parts)expect(part.mesh.isEnabled(),fixture.name+'/'+part.mesh.name+'/'+q).toBe(fixture.visible[q]);
  }
 }
});

test('The balcony roof covers its footprint and casts shadows without entering any camera view',()=>{
 const roof=world.scene.getMeshByName('ceiling-shadow-balcony');
 if(!roof)throw Error('Missing balcony roof');
 roof.computeWorldMatrix(true);
 const box=roof.getBoundingInfo().boundingBox;
 expect(box.minimumWorld.x).toBeCloseTo(0);expect(box.maximumWorld.x).toBeCloseTo(4.8);
 expect(box.minimumWorld.z).toBeCloseTo(0);expect(box.maximumWorld.z).toBeCloseTo(1.4);
 expect(box.minimumWorld.y/HEIGHT_SCALE).toBeCloseTo(2.7);
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  for(const walls of ['cutaway','full','low','hidden'] satisfies readonly WorldOptions['walls'][]){
   world.update({...options,q,walls});
   expect(roof.isEnabled()).toBe(true);expect(roof.layerMask).toBe(SHADOW_LAYER);
   expect(roof.layerMask&world.camera.layerMask).toBe(0);
   expect(world.sunShadow.getShadowMap()?.renderList?.includes(roof)).toBe(true);
   for(const part of world.shell.walls.filter(p=>p.wall.cutawayGroup&&p.mesh.name.startsWith('wall-'))){
    const shadow=world.scene.getMeshByName(part.mesh.name.replace('wall-','wall-shadow-'));
    if(!shadow)throw Error('Missing perimeter shadow');
    expect(shadow.isEnabled()).toBe(true);expect(shadow.layerMask&CAMERA_LAYER).toBe(0);
    expect(world.sunShadow.getShadowMap()?.renderList?.includes(shadow)).toBe(true);
   }
  }
 }
});

test('Default exterior cutaway hides near perimeter walls including void boundaries but retains internal walls in all views',()=>{
 expect(DEFAULT_WALL_DISPLAY).toBe('cutaway');
 const nearNormals=[{x:1,z:1},{x:1,z:-1},{x:-1,z:-1},{x:-1,z:1}];
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  world.update({...options,q,walls:DEFAULT_WALL_DISPLAY});
  const near=nearNormals[q];if(!near)throw Error('Missing view');
  for(const part of world.shell.walls){
   if(part.wall.cutawayGroup)continue; // Grouped returns have explicit four-view fixtures above.
   const internal=part.wall.kind==='inner';
   const facing=part.wall.normal.x*near.x+part.wall.normal.z*near.z>0;
   expect(part.mesh.isEnabled(),part.mesh.name+'/'+q).toBe(internal||!facing);
   if(internal)expect(part.mesh.scaling.y).toBe(1);
  }
  expect(world.scene.meshes.filter(m=>m.name.startsWith('fixed/mirror/')).every(m=>m.layerMask===1)).toBe(true);
 }
 expect(world.scene.meshes.some(m=>m.name.startsWith('fixed/laundry-basin/'))).toBe(false);
 expect(world.shell.walls.filter(p=>p.mesh.name.startsWith('closed-door-')).length).toBe(4);
});

test('Every audited GLB measures its catalogue envelope in metres at all four rotations',()=>{
 const auditedIds=['dyvlinge','teak-sideboard','dejsa','perjohan','byakorre','kirribilli','checker-rug','fireside','docksta','rimforsa','blasverk','era300','era300-stand','arc-ultra','sub4','lg-g4','totem','casalino','stoppino-small','stoppino-medium','stoppino-large','kd27','magazine-rack','gullsudare'];
 for(const productId of [...auditedIds,...photoObjects.map(p=>p.id)]){
  const p=CATALOG.find(p=>p.id===productId);if(!p)throw Error(productId);
  for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
   const item={id:'measure',productId,x:2.5,z:3.5,rotation:q,entityId:'',elevation:0};world.update({...options,items:[item]});world.render(0);
   const boxes=world.scene.meshes.filter(m=>m.name.startsWith('measure/')&&m.getTotalVertices()>0).map(m=>{m.computeWorldMatrix(true);return m.getBoundingInfo().boundingBox;});
   const min=new Vector3(Infinity,Infinity,Infinity),max=new Vector3(-Infinity,-Infinity,-Infinity);
   for(const box of boxes){min.minimizeInPlace(box.minimumWorld);max.maximizeInPlace(box.maximumWorld);}
   expect(Math.abs(max.x-min.x-(q%2?p.d:p.w)),productId+' width').toBeLessThan(.002);expect(Math.abs(max.z-min.z-(q%2?p.w:p.d)),productId+' depth').toBeLessThan(.002);expect(Math.abs((max.y-min.y)/HEIGHT_SCALE-p.h),productId+' height').toBeLessThan(.002);expect(min.y).toBeCloseTo(0,3);
  }
 }
},20000);
test('Custom finishes are isolated per object, and clear racks retain actual transparent pockets',()=>{
 const base={productId:'magazine-rack',x:2.5,z:3.5,rotation:0,entityId:''} satisfies Omit<typeof options.items[number],'id'>;
 world.update({...options,items:[{...base,id:'beige',finish:'beige'},{...base,id:'clear',x:3.5,finish:'clear'}]});
 const materials=(id:string)=>world.scene.meshes.filter(m=>m.name.startsWith(id+'/')).map(m=>m.material).filter(m=>m instanceof StandardMaterial).filter(m=>m.name.includes('finish-primary'));
 expect(materials('clear').length).toBeGreaterThan(0);expect(materials('clear').every(m=>m.alpha===.08)).toBe(true);expect(materials('beige').every(m=>m.alpha===1)).toBe(true);
});
test('Cat clock pupils and tail swing together in every rotation without forcing shadow redraws',()=>{
 for(const rotation of [0,1,2,3] satisfies (0|1|2|3)[]){
  world.update({...options,items:[{id:'clock-qa',productId:'orange-cat-clock',x:3,z:4,rotation,entityId:'',elevation:1.4}]});
  world.render(450);
  const managers=world.scene.morphTargetManagers.filter(m=>m.getTargetByName('clock-right')?.influence===1);
  expect(managers.length).toBeGreaterThan(0);
  expect(managers.some(m=>m.getTargetByName('clock-right')?.getPositions()?.some((v,i)=>Math.abs(v-(m.getTargetByName('clock-left')?.getPositions()?.[i]??v))>.001))).toBe(true);
  world.render(1350);
  expect(managers.every(m=>m.getTargetByName('clock-left')?.influence===1&&m.getTargetByName('clock-right')?.influence===0)).toBe(true);
 }
});
test('Lamp shades glow through their diffuser while coloured bodies stay unlit',()=>{
 for(const productId of ['blasverk','kd27','gullsudare','dejsa','lighthouse-lamp']){
  const item={id:'table-light',productId,x:2.5,z:3.5,rotation:0,entityId:'light.lamp',elevation:.75} satisfies typeof options.items[number];
  world.update({...options,items:[item]});
  const materials=world.scene.meshes.filter(m=>m.name.startsWith('table-light/')).map(m=>m.material).filter(m=>m instanceof StandardMaterial);
  expect(materials.some(m=>m.name.includes('diffuser-lit')&&m.emissiveColor.r>.3),productId).toBe(true);
  expect(materials.filter(m=>m.name.includes('finish-primary')).every(m=>m.emissiveColor.r===0)).toBe(true);
  world.update({...options,items:[item],hass:undefined});expect(materials.every(m=>m.emissiveColor.r===0)).toBe(true);
 }
});

test('Ceiling downlights illuminate downward even when their fixtures are hidden',()=>{
 const item={id:'ceiling-qa',productId:'downlight',x:2.5,z:3.5,rotation:0,entityId:'light.lamp'} satisfies typeof options.items[number];
 const state={...options,items:[item],downlights:true};world.update(state);world.render();
 const source=world.sources.get(item.id),meshes=world.scene.meshes.filter(m=>m.name.startsWith(item.id+'/')&&m.getTotalVertices()>0);
 expect(source?.light.getTypeID()).toBe(2);expect(source?.light.position.y).toBeCloseTo(2.667*HEIGHT_SCALE);
 expect(meshes.some(m=>m.isEnabled())).toBe(true);const intensity=source?.light.intensity;
 world.update({...state,downlights:false});world.render();
 expect(meshes.every(m=>!m.isEnabled())).toBe(true);expect(source?.bulb.isEnabled()).toBe(false);
 expect(source?.light.isEnabled()).toBe(true);expect(source?.light.intensity).toBe(intensity);
 world.update({...state,downlights:false,hass:{...hass,states:{'light.lamp':{entity_id:'light.lamp',state:'off',attributes:{}}}}});
 expect(source?.light.isEnabled()).toBe(false);
 world.update(state);expect(meshes.every(m=>m.isEnabled())).toBe(true);
});

test('Hommey bedding changes cloth and piping per bed without recolouring timber or another instance',()=>{
 const beds=[{id:'green-bed',productId:'kirribilli',x:2.5,z:3.5,rotation:0,entityId:'',bedding:'spearmint'},{id:'pink-bed',productId:'kirribilli',x:6.5,z:3.5,rotation:0,entityId:'',bedding:'rhubarb'}] satisfies typeof options.items;
 world.update({...options,items:beds});
 const colour=(id:string,role:string)=>world.scene.meshes.find(m=>m.name.startsWith(id+'/')&&m.material?.name.includes(role))?.material;
 const green=colour('green-bed','bedding-fabric'),pink=colour('pink-bed','bedding-fabric'),trim=colour('pink-bed','bedding-trim'),wood=colour('pink-bed','finish-primary');
 if(!((green instanceof StandardMaterial)&&(pink instanceof StandardMaterial)&&(trim instanceof StandardMaterial)&&(wood instanceof StandardMaterial)))throw Error('Missing bed materials');
 expect(green.diffuseColor.toHexString().toLowerCase()).toBe('#b3c7b8');expect(pink.diffuseColor.toHexString().toLowerCase()).toBe('#df9fa3');expect(trim.diffuseColor.toHexString().toLowerCase()).toBe('#733a45');
 const frame=wood.diffuseColor.toHexString();
 world.update({...options,items:beds.map(b=>({...b,bedding:'spearmint'}))});
 expect(pink.diffuseColor.toHexString().toLowerCase()).toBe('#b3c7b8');expect(wood.diffuseColor.toHexString()).toBe(frame);
});

test('The closed shower has a full-depth transparent glass pane',()=>{
 world.update(options);world.render();
 const pane=world.scene.meshes.find(m=>m.name.startsWith('fixed/shower/')&&m.material?.name.includes('shower-glass'));
 if(!pane)throw Error('Missing closed shower glass');
 expect(pane.material?.alpha).toBeCloseTo(.12);expect(pane.material?.backFaceCulling).toBe(false);
 const box=pane.getBoundingInfo().boundingBox;
 expect(box.maximumWorld.z-box.minimumWorld.z).toBeCloseTo(1.5,2);
 expect((box.maximumWorld.y-box.minimumWorld.y)/HEIGHT_SCALE).toBeGreaterThan(2);
});


test('Every cat animation fits the wall-clearance radius around its navigation centre',()=>{
 world.update({...options,cats:[{id:'pearl',x:2,z:3,height:0,direction:0,animation:'idle',frame:0}]});world.render();
 let radius=0;
 for(const mesh of world.scene.meshes.filter(m=>m.name.startsWith('pet/pearl/'))){
  const frames=[mesh.getVerticesData('position')];const manager=mesh.morphTargetManager;
  if(manager)for(let i=0;i<manager.numTargets;i++)frames.push(manager.getTarget(i).getPositions());
  for(const positions of frames)if(positions)for(let i=0;i<positions.length;i+=3){const p=Vector3.TransformCoordinates(new Vector3(positions[i]??0,positions[i+1]??0,positions[i+2]??0),mesh.getWorldMatrix());radius=Math.max(radius,Math.hypot(p.x-2,p.z-3));}
 }
 expect(radius).toBeGreaterThan(.35);expect(radius).toBeLessThan(.42);
});

test('Real Giano tabletop picking supplies the support owner and height in every view',()=>{
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  const table={id:'qa-table',productId:'giano',x:2.85,z:5.05,rotation:0,entityId:''} satisfies typeof options.items[number];
  world.update({...options,q,walls:q===0?'cutaway':'hidden',fittings:false,items:[table],ghost:{id:'preview',productId:'kd27',x:2.35,z:4.55,rotation:0,entityId:''}});world.render();
  const pixel=project(table,q,.392),hit=world.pickSurface(pixel.x,pixel.y);
  expect(hit?.owner).toBe(table.id);expect(hit?.height).toBeCloseTo(.392,2);
 }
});

import {KITCHEN_STRIP_ENTITY} from './ha';
test('Kitchen strip follows live state, colour and brightness and shines down onto the bench',()=>{
 const stripHass:Hass={...hass,states:{[KITCHEN_STRIP_ENTITY]:{entity_id:KITCHEN_STRIP_ENTITY,state:'on',attributes:{brightness:128,rgb_color:[255,80,20],color_mode:'rgb'}}}};
 world.update({...options,hass:stripHass});world.render();
 const strip=sceneLights([],stripHass,DEFAULT_ENVIRONMENT).filter(l=>l.entityId===KITCHEN_STRIP_ENTITY);
 expect(strip.length).toBe(6);expect(strip.every(l=>l.height<1.5725&&l.height>.91&&l.kind==='spot')).toBe(true);
 expect(strip.reduce((n,l)=>n+(l.stripLength??0),0)).toBeCloseTo(1.76);
 for(const l of strip){const source=world.sources.get(l.key);expect(source?.light.isEnabled()).toBe(true);expect(source?.light.diffuse.r).toBeGreaterThan(source?.light.diffuse.g??1);expect(source?.material.emissiveColor.r).toBeCloseTo(128/255);expect(source?.light.position.y).toBeCloseTo(1.55*HEIGHT_SCALE);}
 for(const state of ['off','unavailable']){
  world.update({...options,hass:{...stripHass,states:{[KITCHEN_STRIP_ENTITY]:{entity_id:KITCHEN_STRIP_ENTITY,state,attributes:{brightness:255}}}}});
  for(const l of strip){expect(world.sources.get(l.key)?.light.isEnabled()).toBe(false);expect(world.sources.get(l.key)?.material.emissiveColor.r).toBe(0);}
 }
 world.update({...options,hass:stripHass,downlights:false});expect(world.sources.get(strip[0]?.key??'')?.light.isEnabled()).toBe(true);
});

import {APPLE_TV_ENTITY} from './ha';
test('Placed TV uses an emissive animated screen and casts forward light in every rotation',()=>{
 const active:Hass={...hass,states:{[APPLE_TV_ENTITY]:{entity_id:APPLE_TV_ENTITY,state:'playing',attributes:{}}}};
 for(const rotation of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
  const tv={id:'qa-tv',productId:'lg-g4',x:3,z:4,rotation,entityId:''};
  world.update({...options,items:[tv],hass:active});world.render(0);world.render(200);
  const screen=world.scene.meshes.filter(m=>m.isEnabled()&&(m.name.startsWith('qa-tv/')||m.name==='screen-face')).map(m=>m.material).find(m=>(m instanceof StandardMaterial)&&m.name.includes('screen-lit'));
  expect(screen instanceof StandardMaterial).toBe(true);if(!(screen instanceof StandardMaterial))throw Error('Missing TV screen');
  expect(screen.emissiveTexture?.name).toBe('Apple TV pixel picture');expect(screen.emissiveColor.r).toBe(1);
  const light=world.sources.get('qa-tv/screen');expect(light?.light.isEnabled()).toBe(true);expect(light?.bulb.isEnabled()).toBe(false);
  const sceneLight=sceneLights([tv],active,DEFAULT_ENVIRONMENT).find(l=>l.screen);expect(sceneLight?.direction).toBeDefined();
  expect(Math.hypot((sceneLight?.x??3)-3,(sceneLight?.z??4)-4)).toBeCloseTo(.09);
  world.update({...options,items:[tv],hass:undefined});world.render(400);expect(screen.emissiveTexture).toBeNull();expect(screen.emissiveColor.r).toBe(0);expect(light?.light.isEnabled()).toBe(false);
 }
});

test('Kitchen strip and TV cannot crowd room lamps out of the floor lighting budget',()=>{
 const night:WorldOptions['environment']={...DEFAULT_ENVIRONMENT,mode:'night',previewLights:true};
 const items=[{id:'floor-lamp',productId:'okensand',x:2.5,z:3.5,rotation:0,entityId:'light.lamp'},{id:'pendant',productId:'gullsudare',x:3.3,z:5,rotation:0,entityId:'light.pendant'},{id:'tv',productId:'lg-g4',x:4.66,z:3,rotation:1,entityId:''}] satisfies typeof options.items;
 for(const q of [0,1,2,3] satisfies readonly (0|1|2|3)[]){
 world.update({...options,q,items,environment:night});world.render();
 const floor=world.scene.meshes.find(m=>m.name.startsWith('floor-')&&(m.material instanceof StandardMaterial));if(!floor||!((floor.material instanceof StandardMaterial)))throw Error('Missing lit floor');
 const rendered=floor.lightSources.slice(0,floor.material.maxSimultaneousLights);
 const lamp=world.sources.get('floor-lamp');if(!lamp)throw Error('Missing room lamp');
 expect(rendered.includes(lamp.light)).toBe(true);
 expect(floor.material.maxSimultaneousLights).toBeLessThanOrEqual(12);
 }
});

test('Loading GLB models after saved lamps cannot expand shaders past the GPU light budget',async()=>{
 const e=new NullEngine({renderWidth:960,renderHeight:720,textureSize:512,deterministicLockstep:false,lockstepMaxSteps:4});
 const w=new ApartmentWorld(e);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const name=new URL(req.url).pathname.split('/').at(-1);return new Response(Bun.file(new URL('../public/models/'+name,import.meta.url)));}});
 try{
  const items=Array.from({length:8},(_,i)=>({id:'lit-'+i,productId:'okensand',x:2+i*.3,z:3,rotation:0,entityId:'light.test'})) satisfies typeof options.items;
  w.update({...options,items,environment:{...DEFAULT_ENVIRONMENT,mode:'night',previewLights:true}});
  await w.load(`http://127.0.0.1:${server.port}`);w.render();
  const materials=w.scene.materials.filter(m=>m instanceof StandardMaterial);
  expect(materials.length).toBeGreaterThan(100);
  expect(Math.max(...materials.map(m=>m.maxSimultaneousLights))).toBeLessThanOrEqual(12);
 }finally{server.stop(true);w.dispose();e.dispose();}
});

test('an unchanged furnished scene stops drawing, including unrelated HA updates',()=>{
 const staticOptions:WorldOptions={...options,hass:undefined,environment:{...DEFAULT_ENVIRONMENT,mode:'night'}};
 world.update(staticOptions);world.render(1000);world.render(1100);
 // NullEngine cannot complete real GPU compilation. Browser benchmarks cover that path.
 const readiness=spyOn(world.scene,'isReady').mockReturnValue(true);world.render(1150);
 let draws=0;const observer=world.scene.onBeforeRenderObservable.add(()=>draws++);
 for(let i=0;i<60;i++){
  world.update({...staticOptions,hass:{states:{'sensor.unrelated':{entity_id:'sensor.unrelated',state:String(i),attributes:{}}},callService:hass.callService}});
  world.render(1200+i*40);
 }
 world.scene.onBeforeRenderObservable.remove(observer);readiness.mockRestore();
 expect(draws).toBe(0);
});

test('TV picture frames reuse shadows; movement and sunlight invalidate them',()=>{
 const tv:WorldOptions['items'][number]={id:'perf-tv',productId:'lg-g4',x:4.66,z:2.6,rotation:1,entityId:''};
 const active={...hass,states:{...hass.states,'media_player.example_tv':{entity_id:'media_player.example_tv',state:'playing',attributes:{}}}};
 const state={...options,items:[...options.items,tv],hass:active};
 world.update(state);world.render(5000);
 const map=world.sunShadow.getShadowMap();expect(map?.refreshRate).toBe(0);
 // Consume the first refresh, then verify only geometry changes request another.
 map?._shouldRender();expect(map?._shouldRender()).toBe(false);
 world.render(5200);expect(map?._shouldRender()).toBe(false);
 world.update({...state,items:state.items.map(i=>i.id==='lamp'?{...i,x:i.x+.1}:i)});
 expect(map?._shouldRender()).toBe(true);expect(map?._shouldRender()).toBe(false);
 world.update({...state,hass:{...active,states:{...active.states,'sun.sun':{entity_id:'sun.sun',state:'above_horizon',attributes:{elevation:41,azimuth:50}}}}});
 expect(map?._shouldRender()).toBe(true);
});

test('cat movement refreshes nearby shadows and leaves distant strip shadows cached',()=>{
 const state:WorldOptions={...options,environment:{...DEFAULT_ENVIRONMENT,mode:'night',previewLights:true},cats:[{id:'pearl',x:7,z:1,height:0,direction:0,animation:'walk',frame:0}]};
 world.update(state);world.render(9000);
 const strip=world.sources.get('kitchen-strip/0/0')?.shadow.getShadowMap();
 strip?._shouldRender();expect(strip?._shouldRender()).toBe(false);
 world.update({...state,cats:[{...state.cats[0],id:'pearl',x:7.1,z:1,direction:0,animation:'walk',frame:1}]});
 expect(strip?._shouldRender()).toBe(false);
 world.update({...state,cats:[{id:'pearl',x:.8,z:3.4,height:.9,direction:0,animation:'walk',frame:2}]});
 expect(strip?._shouldRender()).toBe(true);
 // Moving away must clear the shadow at the previous location as well.
 world.update({...state,cats:[]});expect(strip?._shouldRender()).toBe(true);
});

test('short-range strip lights exclude distant furniture from their shadow draws',()=>{
 world.update(options);world.render(10000);
 const strip=world.sources.get('kitchen-strip/0/0')?.shadow.getShadowMap();
 expect(strip?.renderList?.length).toBeGreaterThan(0);
 expect(strip?.renderList?.some(m=>m.name.startsWith('fixed/robe/'))).toBe(false);
 expect(strip?.renderList?.some(m=>m.name.startsWith('fixed/kitchen-run/'))).toBe(true);
});

test('shaders finishing during a draw receive a final complete frame before sleep',()=>{
 let ready=false,draws=0;const readiness=spyOn(world.scene,'isReady').mockImplementation(()=>ready);
 const observer=world.scene.onBeforeRenderObservable.add(()=>{draws++;ready=true;});
 world.update({...options,hass:undefined},true);
 world.render(11000);world.render(11100);world.render(11200);
 world.scene.onBeforeRenderObservable.remove(observer);readiness.mockRestore();
 expect(draws).toBe(2);
});

test('placed group-bound downlights replace estimated member lights without duplicating them',()=>{
 const group='light.living_room_overhead_lights',members=['light.example_living_downlight_1','light.example_living_downlight_2','light.example_living_downlight_3'];
 const grouped:Hass={...hass,states:{[group]:{entity_id:group,state:'on',attributes:{brightness:255,entity_id:members}}}};
 const items=members.map((_,index)=>({id:'ceiling-'+index,productId:'downlight',x:1+index,z:3,rotation:0,entityId:group} satisfies WorldOptions['items'][number]));
 const lights=sceneLights(items,grouped,DEFAULT_ENVIRONMENT);
 expect(lights.filter(l=>members.includes(l.entityId))).toHaveLength(0);
 expect(lights.filter(l=>l.entityId===group)).toHaveLength(3);
});

test('DEJSA opal glass visibly glows at dimmed group brightness while its emitter stays proportional',()=>{
 const items:WorldOptions['items']=[{id:'dejsa-test',productId:'dejsa',x:5.9,z:.25,rotation:0,elevation:.67,entityId:'light.bedside_lamps'}];
 const states:Hass['states']={'light.bedside_lamps':{entity_id:'light.bedside_lamps',state:'on',attributes:{brightness:112,color_temp_kelvin:2403}}};
 world.update({...options,items,hass:{...hass,states}});
 const shade=world.scene.meshes.find(m=>m.name.startsWith('dejsa-test/')&&m.material?.name.includes('dejsa-diffuser-lit'))?.material;
 if(!(shade instanceof StandardMaterial))throw Error('Missing DEJSA opal glass material');
 expect(shade.emissiveColor.r).toBeGreaterThan(1);
 expect(shade.emissiveColor.b/shade.emissiveColor.r).toBeGreaterThan(.6);
 const source=world.sources.get('dejsa-test');
 expect(source?.light.intensity).toBeCloseTo(112/255*.8);
 expect(source?.light.position.y).toBeCloseTo((.67+.21)*HEIGHT_SCALE);
 for(const state of ['off','unavailable']){
  states['light.bedside_lamps']={entity_id:'light.bedside_lamps',state,attributes:{brightness:112}};
  world.update({...options,items,hass:{...hass,states}});
  expect(shade.emissiveColor.r).toBe(0);expect(source?.light.isEnabled()).toBe(false);
 }
});

// A slider drag must update light uniforms without rendering every cached shadow again.
test('Dragging public room brightness preserves static shadow maps',()=>{
 const items=parseItems(JSON.stringify(initialPublic.items),true);
 const base={...options,items,cats:[],hass:undefined,environment:{...DEFAULT_ENVIRONMENT,mode:'night'}} satisfies WorldOptions;
 world.update({...base,sceneLights:simulatedLights(items,{},65,65)},true);
 const maps=[...world.sources.values()].flatMap(s=>{const map=s.shadow.getShadowMap();return map?[map]:[];});
 const resets=maps.map(map=>spyOn(map,'resetRefreshCounter'));
 const orders=new Map(world.scene.meshes.map(mesh=>[mesh,[...mesh.lightSources]]));
 const start=performance.now();
 for(let value=0;value<=100;value+=5)world.update({...base,sceneLights:simulatedLights(items,{},value,value)});
 const elapsed=performance.now()-start,count=resets.reduce((sum,spy)=>sum+spy.mock.calls.length,0);
 resets.forEach(spy=>spy.mockRestore());
 console.log('Slider full sweep: 21 updates',Math.round(elapsed),'ms; shadow invalidations',count);
 expect(count).toBe(0);
 const reranked=world.scene.meshes.filter(mesh=>orders.get(mesh)?.some((light,i)=>light!==mesh.lightSources[i])).length;
 expect(reranked).toBe(0);
});

test('Public light interaction defers cat shadow work and refreshes it after settling',()=>{
 const items=parseItems(JSON.stringify(initialPublic.items),true);
 const state={...options,items,cats:[],hass:undefined,environment:{...DEFAULT_ENVIRONMENT,mode:'night'},sceneLights:simulatedLights(items,{},65,65)} satisfies WorldOptions;
 world.update(state,true);
 const source=[...world.sources.values()].find(s=>s.light.range>4);if(!source)throw Error('Missing room light');
 const map=source.shadow.getShadowMap();if(!map)throw Error('Missing room shadow');
 const spy=spyOn(map,'resetRefreshCounter');
 try{
  world.update({...state,cats:[{id:'pearl',x:source.light.position.x,z:source.light.position.z,height:0,direction:0,animation:'walk',frame:1}],sceneLights:simulatedLights(items,{},70,70)});
  expect(spy.mock.calls.length).toBe(0);
  world.render(performance.now()+250);
  expect(spy.mock.calls.length).toBeGreaterThan(0);
 }finally{spy.mockRestore();}
});

test('White shades keep reflecting room light when off or dimmed; only emission follows brightness',()=>{
 for(const productId of ['okensand','kd27','dejsa','blasverk','gullsudare','lighthouse-lamp']){
  const item={id:'shade-check',productId,x:2.5,z:3.5,rotation:0,entityId:'light.lamp'} satisfies WorldOptions['items'][number];
  for(const brightness of [0,1,5,128,255]){
   const state:Hass={...hass,states:{...hass.states,'light.lamp':{entity_id:'light.lamp',state:brightness?'on':'off',attributes:{brightness,color_temp_kelvin:2700}}}};
   for(const publicView of [false,true]){
    world.update({...options,items:[item],hass:state,...publicView?{sceneLights:sceneLights([item],state,DEFAULT_ENVIRONMENT)}:{}});
    const shades=world.scene.meshes.filter(m=>m.name.startsWith('shade-check/')).map(m=>m.material).filter(m=>m instanceof StandardMaterial).filter(m=>/lamp-diffuser-|diffuser-lit/.test(m.name));
    expect(shades.length,productId).toBeGreaterThan(0);
    for(const shade of shades){
     expect(shade.disableLighting,`${productId} ${brightness}/255 must reflect ambient light`).toBe(false);
     expect(shade.diffuseColor.r).toBeGreaterThan(.6);expect(shade.diffuseColor.b).toBeGreaterThan(.5);
     if(brightness===0)expect(shade.emissiveColor.r+shade.emissiveColor.g+shade.emissiveColor.b).toBe(0);
     else expect(shade.emissiveColor.r+shade.emissiveColor.g+shade.emissiveColor.b).toBeGreaterThan(0);
    }
   }
  }
 }
});

test('Mirror cache survives unrelated clock animation and refreshes after lighting or camera changes',()=>{
 const items:WorldOptions['items']=[{id:'cache-mirror',productId:'ikornnes',x:3,z:4,rotation:3,entityId:''},{id:'cache-clock',productId:'orange-cat-clock',x:-20,z:4,rotation:0,entityId:''}];
 const state={...options,items};const ready=spyOn(world.scene,'isReady').mockReturnValue(true);
 try{
  world.update(state,true);world.render(1000);
  const glass=world.scene.meshes.find(m=>m.name.startsWith('cache-mirror/')&&m.material?.name.includes('mirror-silver'));
  if(!((glass?.material instanceof StandardMaterial)&&(glass.material.reflectionTexture instanceof MirrorTexture)))throw Error('Missing mirror');
  const texture=glass.material.reflectionTexture,refresh=spyOn(texture,'resetRefreshCounter');
  try{
   world.render(1200);expect(refresh).not.toHaveBeenCalled();
   world.update({...state,hass:{...hass,states:{...hass.states,'sun.sun':{entity_id:'sun.sun',state:'above_horizon',attributes:{elevation:30,azimuth:50}}}}});world.render(1200);
   expect(refresh).toHaveBeenCalled();refresh.mockClear();
   world.update({...state,q:1});world.render(1200);expect(refresh).toHaveBeenCalled();
  }finally{refresh.mockRestore();}
 }finally{ready.mockRestore();}
});

test('Public model loading fetches only required furniture, deduplicates requests and supports new layout models',async()=>{
 const e=new NullEngine(),w=new ApartmentWorld(e),requests:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const name=new URL(req.url).pathname.split('/').at(-1)??'';requests.push(name);const file=Bun.file(new URL('../public/models/'+name.replace(/\.gz$/,''),import.meta.url));return new Response(name.endsWith('.gz')?Bun.gzipSync(await file.arrayBuffer()):file);}});
 try{
  const base=`http://127.0.0.1:${server.port}`;
  await Promise.all([w.load(base,['dejsa']),w.load(base,['dejsa'])]);
  expect(requests.filter(name=>name==='dejsa.glb')).toHaveLength(1);expect(requests).not.toContain('fireside-dressed.glb');expect(requests).toContain('pearl.glb');expect(requests).toContain('kitchen-run.glb');
  const first=requests.length;await w.load(base,['dejsa']);expect(requests).toHaveLength(first);
  w.update({...options,items:[{id:'incoming-sofa',productId:'fireside-dressed',x:3,z:3,rotation:0,entityId:''}]});
  await w.load(base,['dejsa','fireside-dressed']);expect(requests).toHaveLength(first+1);
  expect(w.scene.meshes.some(m=>m.name.startsWith('incoming-sofa/'))).toBe(true);
  await w.load(base,['kd27'],true);expect(requests).toContain(typeof DecompressionStream==='undefined'?'kd27.glb':'kd27.glb.gz');
 }finally{server.stop(true);w.dispose();e.dispose();}
},20000);


test('A held lighting slider defers pet shadows beyond the debounce and flushes on release',()=>{
 const items=parseItems(JSON.stringify(initialPublic.items),true);
 const state={...options,items,cats:[],hass:undefined,environment:{...DEFAULT_ENVIRONMENT,mode:'night'},sceneLights:simulatedLights(items,{},65,65)} satisfies WorldOptions;
 world.update(state,true);world.render(performance.now());
 const map=world.sunShadow.getShadowMap();if(!map)throw Error('Missing shadow map');
 const refresh=spyOn(map,'resetRefreshCounter');world.setLightingInteraction(true);
 try{
  world.update({...state,cats:[{id:'pearl',x:2,z:3,height:0,direction:0,animation:'walk',frame:1}]});
  world.render(performance.now()+10000);expect(refresh).not.toHaveBeenCalled();
  world.setLightingInteraction(false);world.render(performance.now()+200);expect(refresh).toHaveBeenCalled();
 }finally{world.setLightingInteraction(false);refresh.mockRestore();}
});

test('Zero-output public lights keep shader slots but defer stale shadows until they illuminate again',()=>{
 const lights=sceneLights(options.items,hass,DEFAULT_ENVIRONMENT).map(light=>({...light,brightness:0}));
 const off={...options,sceneLights:lights};world.update(off,true);world.render(performance.now());
 const source=world.sources.get('lamp'),map=source?.shadow.getShadowMap();if(!source||!map)throw Error('Missing placed lamp');
 expect(source.light.isEnabled()).toBe(true);expect(source.light.intensity).toBe(0);
 map._shouldRender();expect(map._shouldRender()).toBe(false);
 const cats:WorldOptions['cats']=[{id:'pearl',x:2.6,z:3.5,height:0,direction:0,animation:'walk',frame:1}];
 world.update({...off,cats});world.render(performance.now()+1000);
 expect(map._shouldRender()).toBe(false);
 world.update({...off,cats,sceneLights:lights.map(light=>({...light,brightness:1}))});
 expect(map._shouldRender()).toBe(true);
});
