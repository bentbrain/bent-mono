import {ShadowCachePool,StaticShadowCache} from './shadowCache';
import {CONTEXT_RECOVERY_TIMEOUT_MS,type GraphicsRuntimeOptions} from './graphicsRecovery';
import {MirrorView} from './mirrorView';
import {isWallCutAway} from './wallVisibility';
import {prioritizeRoomLights,enforceLightBudget,withinLightRange} from './lightSelection';
import {ImageProcessingConfiguration} from '@babylonjs/core/Materials/imageProcessingConfiguration';
import {RawTexture} from '@babylonjs/core/Materials/Textures/rawTexture';
import {Texture} from '@babylonjs/core/Materials/Textures/texture';
import {MirrorTexture} from '@babylonjs/core/Materials/Textures/mirrorTexture';
import {Plane} from '@babylonjs/core/Maths/math.plane';
import {televisionMode,televisionPixels,TelevisionClock,TV_WIDTH,TV_HEIGHT} from './television';
import modelManifest from '../public/models/manifest.json';
import photoObjects from '../data/photo-objects.json';
import {AssetContainer, type InstantiatedEntries} from '@babylonjs/core/assetContainer';
import {Camera} from '@babylonjs/core/Cameras/camera';
import {FreeCamera} from '@babylonjs/core/Cameras/freeCamera';
import {Color3,Color4} from '@babylonjs/core/Maths/math.color';
import {Matrix,Vector3} from '@babylonjs/core/Maths/math.vector';
import {Engine} from '@babylonjs/core/Engines/engine';
import {type AbstractEngine} from '@babylonjs/core/Engines/abstractEngine';
import {Scene} from '@babylonjs/core/scene';
import {DirectionalLight} from '@babylonjs/core/Lights/directionalLight';
import {HemisphericLight} from '@babylonjs/core/Lights/hemisphericLight';
import {Light} from '@babylonjs/core/Lights/light';
import {PointLight} from '@babylonjs/core/Lights/pointLight';
import {SpotLight} from '@babylonjs/core/Lights/spotLight';
import {ShadowGenerator} from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import {GlowLayer} from '@babylonjs/core/Layers/glowLayer';
import {AbstractMesh} from '@babylonjs/core/Meshes/abstractMesh';
import {Mesh} from '@babylonjs/core/Meshes/mesh';
import {MeshBuilder} from '@babylonjs/core/Meshes/meshBuilder';
import {TransformNode} from '@babylonjs/core/Meshes/transformNode';
import {PBRMaterial} from '@babylonjs/core/Materials/PBR/pbrMaterial';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial';
import {SceneLoader} from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF/glTFFileLoader';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/core/Rendering/outlineRenderer';
import '@babylonjs/core/Culling/ray';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import {rotateAroundOrigin,type CameraQuarter} from '@apartment-hotel/scene-engine';
import {CENTER,type Rect} from './plan';
import {FIXED_FITTINGS,FIXED_MODEL_IDS} from './fixedFittings';
import {BEDDING,CATALOG,baseHeight,productFor,bounds,placeable,type Item} from './editorState';
import {HEIGHT,WIDTH,type RenderOptions} from './scene';
import {makeShell,CAMERA_LAYER,SHADOW_LAYER,HEIGHT_SCALE,type Shell} from './worldShell';
import {sceneLights,sunlight,type Environment,type SceneLight,type Sunlight,DEFAULT_ENVIRONMENT} from './lighting';
export interface WorldOptions extends RenderOptions {environment:Environment;downlights?:boolean;sceneLights?:SceneLight[];sunlight?:Sunlight;background?:'light'|'dark'}
interface PlacedModel {root:TransformNode;entries:InstantiatedEntries;meshes:AbstractMesh[];model:string}
interface BoundLight {cache?:StaticShadowCache;ownerId?:string;shadowStale?:boolean;light:PointLight|SpotLight;shadow:ShadowGenerator;bulb:Mesh;material:StandardMaterial}
const modelHashes=new Map(Object.entries(modelManifest.hashes));
const photoModelIds=new Set(photoObjects.map(p=>p.id));
const PIXELS_PER_METRE=48*Math.sqrt(2);
function rgb(color:string):Color3 {
 if(color.startsWith('#'))return Color3.FromHexString(color);
 const match=/rgb\(([^)]+)\)/.exec(color);const values=match?.[1]?.split(',').map(Number);
 return values?.length===3?new Color3((values[0]??255)/255,(values[1]??224)/255,(values[2]??163)/255):new Color3(1,.88,.64);
}
/** World coordinates and saved layouts stay in metres. Only height has the original art correction. */
export function configureCamera(camera:FreeCamera,q:CameraQuarter):void {
 const inverse:CameraQuarter=q===1?3:q===3?1:q;
 const offset=rotateAroundOrigin({x:10,z:10},inverse);
 camera.position.set(CENTER.x+offset.x,10*Math.sqrt(2/3),CENTER.z+offset.z);
 camera.setTarget(new Vector3(CENTER.x,0,CENTER.z));camera.mode=Camera.ORTHOGRAPHIC_CAMERA;
 camera.orthoLeft=-WIDTH/2/PIXELS_PER_METRE;camera.orthoRight=WIDTH/2/PIXELS_PER_METRE;
 camera.orthoTop=365/PIXELS_PER_METRE;camera.orthoBottom=-(HEIGHT-365)/PIXELS_PER_METRE;
 camera.minZ=.05;camera.maxZ=100;camera.layerMask=CAMERA_LAYER;
}
export class ApartmentWorld {
 readonly scene:Scene;
 readonly camera:FreeCamera;
 readonly shell:Shell;
 readonly sky:HemisphericLight;
 readonly sun:DirectionalLight;
 readonly sunShadow:ShadowGenerator;
 readonly lampGlow:GlowLayer;
 readonly sources=new Map<string,BoundLight>();
 private templates=new Map<string,AssetContainer>();
 private loading=new Map<string,Promise<void>>();
 private readonly redShadowTextures:boolean;
 private shadowCachePool:ShadowCachePool|null=null;
 private mirrors=new Map<string,MirrorTexture>();
 private models=new Map<string,PlacedModel>();
 private mirrorViews=new Map<string,MirrorView>();
 private mirrorDirty=new Set<string>();
 private reflectedDynamic=new Map<string,Set<AbstractMesh>>();
 private selected:Mesh|null=null;
 private ghost:PlacedModel|null=null;
 private options:WorldOptions|null=null;
 private placements:readonly Item[]|null=null;
 private selectedId:string|null=null;
 private ghostKey='';
 private poses=new Map<string,string>();
 private disposed=false;
 private loadAbort=new AbortController();
 private presentationPaused=false;
 private lightingInteraction=false;
 private lightSelectionKey='';
 private visualKey='';
 private shadowKey='';
 private mirrorDisplayKey='';
 private catShadowKey='';
 private lightingSettlesAt=0;
 private deferredCatShadows=false;
 private shadowCats:WorldOptions['cats']=[];
 private lightingKey='';
 private casterGeometryKey='';
 private dirty=true;
 private settling=true;
 private televisionTexture:RawTexture|null=null;
 private televisionClock=new TelevisionClock();
 private televisionFrame='';
 constructor(readonly engine:AbstractEngine){
  const caps=engine.getCaps();this.redShadowTextures=Boolean((caps.textureHalfFloatRender&&caps.textureHalfFloatLinearFiltering)||(caps.textureFloatRender&&caps.textureFloatLinearFiltering));
  const scene=this.scene=new Scene(engine);scene.useRightHandedSystem=true;
  scene.clearColor=new Color4(.525,.831,.91,1);scene.ambientColor=Color3.Black();
  // Compress the brightest highlights in the material pass, without another screen-sized pass.
  scene.imageProcessingConfiguration.toneMappingEnabled=true;
  scene.imageProcessingConfiguration.toneMappingType=ImageProcessingConfiguration.TONEMAPPING_STANDARD;
  this.camera=new FreeCamera('isometric',new Vector3(14.5,8.165,13.5),scene);configureCamera(this.camera,0);scene.activeCamera=this.camera;
  this.shell=makeShell(scene);
  this.lampGlow=new GlowLayer('lamp-shades',scene,{mainTextureFixedSize:512,blurKernelSize:6,camera:this.camera});this.lampGlow.intensity=.25;
  this.lampGlow.customEmissiveColorSelector=(_mesh,_subMesh,material,result)=>{
   const glow=material instanceof StandardMaterial&&(material.name.includes('surface-#fff5d6-lit')||material.name.includes('lamp-diffuser-')||material.name.includes('lamp-bulb')||material.name.includes('diffuser-lit')||material.name==='kitchen-strip-diffuser'||material.name.includes('screen-lit'))?material.emissiveColor:Color3.Black();
   result.set(glow.r,glow.g,glow.b,1);
  };
  this.sky=new HemisphericLight('sky',Vector3.Up(),scene);this.sky.intensity=.65;this.sky.groundColor=new Color3(.22,.18,.16);
  this.sun=new DirectionalLight('sun',new Vector3(-.5,-1,.5),scene);this.sun.position=new Vector3(10,20,-5);this.sun.intensity=1;
  this.sun.shadowMinZ=1;this.sun.shadowMaxZ=60;this.sun.autoCalcShadowZBounds=true;this.sun.shadowOrthoScale=.1;
  this.sunShadow=new ShadowGenerator(2048,this.sun,false,undefined,this.redShadowTextures);this.sunShadow.forceBackFacesOnly=true;this.sunShadow.bias=.001;this.sunShadow.normalBias=0;this.sunShadow.usePercentageCloserFiltering=true;this.sunShadow.filteringQuality=ShadowGenerator.QUALITY_LOW;
  const gl=engine.getRenderingCanvas()?.getContext('webgl2');if(typeof WebGL2RenderingContext!=='undefined'&&gl instanceof WebGL2RenderingContext)this.shadowCachePool=new ShadowCachePool(gl);
  this.refreshCasters();
  scene.skipPointerMovePicking=true;
 }
 async load(base:string,modelIds:readonly string[]=CATALOG.map(p=>p.id),compressed=false):Promise<void>{
  const names=[...new Set([...modelIds,...FIXED_MODEL_IDS,'pearl','maree'])].filter(name=>!this.templates.has(name));
  if(!names.length||this.disposed)return;
  await Promise.all(names.map(name=>{
   const pending=this.loading.get(name);if(pending)return pending;
   const promise=this.loadTemplate(base,name,compressed).catch((error:unknown)=>{throw new Error(`Model ${name}: ${error instanceof Error?error.message:'load failed'}`,{cause:error});}).finally(()=>this.loading.delete(name));
   this.loading.set(name,promise);return promise;
  }));
  if(this.options&&!this.disposed)this.update(this.options,true);
 }
 private async loadTemplate(base:string,name:string,compressed:boolean):Promise<void>{
  const packed=compressed&&typeof DecompressionStream!=='undefined';
  const url=`${base.replace(/\/$/,'')}/${name}.glb`;
  const version=modelHashes.get(name)??modelManifest.version;
  let encoded=packed,response=await fetch(`${url}${packed?'.gz':''}?v=${version}`,{signal:this.loadAbort.signal});
  // Development serves the source GLBs; production adds the packed copies.
  if(packed&&response.status===404){response=await fetch(`${url}?v=${version}`,{signal:this.loadAbort.signal});encoded=false;}
  if(!response.ok)throw Error(`HTTP ${response.status}`);
  const body=encoded&&response.body?new Response(response.body.pipeThrough(new DecompressionStream('gzip'))):response;
  const bytes=new Uint8Array(await body.arrayBuffer());if(this.disposed)return;
  const container=await SceneLoader.LoadAssetContainerAsync('',bytes,this.scene,undefined,'.glb');
  if(this.disposed){container.dispose();return;}
  // Share each source material inside its template. Placed items still clone
  // materials independently, so their colour and lamp bindings stay isolated.
  const materials=new Map<PBRMaterial,StandardMaterial>();
  for(const mesh of container.meshes){
   const source=mesh.material;
   if(source instanceof PBRMaterial){
    let material=materials.get(source);
    if(!material){material=new StandardMaterial(source.name+'-lit',this.scene);material.diffuseColor=source.albedoColor.toGammaSpace();material.specularColor=Color3.Black();material.maxSimultaneousLights=12;material.alpha=source.alpha;material.backFaceCulling=source.backFaceCulling;materials.set(source,material);}
    mesh.material=material;
   }
   mesh.receiveShadows=true;
  }
  this.templates.set(name,container);
 }
 private instantiate(id:string,model:string):PlacedModel|null{
  const template=this.templates.get(model);if(!template)return null;
  const entries=template.instantiateModelsToScene(name=>id+'/'+name,true,{doNotInstantiate:true});
  const root=new TransformNode(id,this.scene);
  for(const node of entries.rootNodes)if(node instanceof TransformNode){node.parent=root;if(model==='pearl'||model==='maree')node.position.z+=.067;}
  if(model==='gullsudare'){
   const cord=MeshBuilder.CreateCylinder('pendant-cord',{diameter:.007,height:1,tessellation:6},this.scene);cord.parent=root;
   const material=new StandardMaterial('pendant-cord',this.scene);material.diffuseColor=Color3.FromHexString('#e5e3dc');cord.material=material;
  }
  if(model==='lg-g4'){
   // The imported bevelled box has atlas UVs; a dedicated front plane keeps the picture undistorted.
   for(const mesh of root.getChildMeshes())if(mesh.material?.name.includes('screen-lit'))mesh.setEnabled(false);
   const screen=MeshBuilder.CreatePlane('screen-face',{width:1.207,height:.684*HEIGHT_SCALE},this.scene);screen.parent=root;screen.position.set(0,.3515*HEIGHT_SCALE,.016);screen.rotation.y=Math.PI;
   screen.material=new StandardMaterial('screen-lit',this.scene);
  }
  const meshes=root.getChildMeshes();
  // These animations select at most one authored pose. Keep a fixed shader
  // layout instead of recompiling while weights briefly pass through zero/two.
  if(model==='pearl'||model==='maree'||model==='orange-cat-clock')for(const mesh of meshes)if(mesh instanceof Mesh&&mesh.morphTargetManager)mesh.morphTargetManager.numMaxInfluencers=1;
  for(const mesh of meshes){mesh.receiveShadows=true;mesh.layerMask=CAMERA_LAYER;mesh.metadata={itemId:id};if(mesh instanceof Mesh){mesh.renderOutline=!mesh.material?.name.includes('diffuser')&&!mesh.material?.name.includes('textile-thread-');mesh.outlineColor=Color3.FromHexString('#303635');mesh.outlineWidth=photoModelIds.has(model)?.0015:model==='casalino'||model==='kd27'?.003:.009;}}
  const placed={root,entries,meshes,model};return placed;
 }
 private remove(placed:PlacedModel):void{this.mirrors.get(placed.root.name)?.dispose();this.mirrors.delete(placed.root.name);this.mirrorViews.delete(placed.root.name);this.mirrorDirty.delete(placed.root.name);this.reflectedDynamic.delete(placed.root.name);placed.entries.dispose();placed.root.dispose();}
 private refreshCasters():void{
  for(const source of this.sources.values())source.cache?.invalidate();
  const casters:AbstractMesh[]=[...this.shell.casters];
  for(const model of this.models.values())casters.push(...model.meshes.filter(m=>m.getTotalVertices()>0&&(m.material?.alpha??1)>.2));
  const sunMap=this.sunShadow.getShadowMap();if(sunMap){sunMap.renderList=casters;sunMap.refreshRate=0;sunMap.resetRefreshCounter();}
  for(const [key,source] of this.sources){const excluded=new Set(this.models.get(source.ownerId??key)?.meshes??[]),map=source.shadow.getShadowMap();if(map){map.renderList=casters.filter(mesh=>!excluded.has(mesh)&&(mesh.name.startsWith('pet/')||withinLightRange(mesh,source.light)));map.refreshRate=0;map.resetRefreshCounter();}}
 }
 private invalidateMirrors(meshes?:AbstractMesh[]):void{
  for(const [id,view] of this.mirrorViews){
   if(!meshes){this.mirrorDirty.add(id);continue;}
   const previous=this.reflectedDynamic.get(id)??new Set<AbstractMesh>();
   for(const mesh of meshes){const visible=view.sees(mesh);if(visible||previous.has(mesh))this.mirrorDirty.add(id);if(visible)previous.add(mesh);else previous.delete(mesh);}
   this.reflectedDynamic.set(id,previous);
  }
 }
 private updatePlacements(items:readonly Item[],force=false):void{
  if(items===this.placements&&!force)return;this.placements=items;
  const definitions=[...FIXED_FITTINGS.filter(f=>f.render!==false).map(f=>({id:'fixed/'+f.id,model:f.model,x:f.x,z:f.z,rotation:f.rotation})),...items.map(i=>({id:i.id,model:i.productId,x:i.x,z:i.z,rotation:i.rotation})),{id:'pet/pearl',model:'pearl',x:0,z:0,rotation:0},{id:'pet/maree',model:'maree',x:0,z:0,rotation:0}];
  const keys=new Set(definitions.map(d=>d.id));
  for(const [key,model] of this.models)if(!keys.has(key)){this.remove(model);this.models.delete(key);}
  for(const item of definitions){
   let model=this.models.get(item.id);
   if(model?.model!==item.model){if(model)this.remove(model);model=this.instantiate(item.id,item.model)??undefined;if(model)this.models.set(item.id,model);}
   if(model){const placed=items.find(i=>i.id===item.id);model.root.position.set(item.x,placed?baseHeight(placed)*HEIGHT_SCALE:0,item.z);model.root.rotation.y=-item.rotation*Math.PI/2;
    if(placed){
     for(const mesh of model.meshes)if(mesh.material?.name.includes('seat-pad'))mesh.setEnabled(placed.seatPad??false);
     const cord=model.meshes.find(m=>m.name==='pendant-cord');if(cord){const top=productFor(placed.productId)?.h??.7,height=Math.max(.001,2.7-baseHeight(placed)-top);cord.scaling.y=height*HEIGHT_SCALE;cord.position.y=(top+height/2)*HEIGHT_SCALE;}
     const bedding=BEDDING.find(b=>b.id===placed.bedding)??BEDDING[0];
     if(placed.productId==='kirribilli'&&bedding)for(const mesh of model.meshes)if(mesh.material instanceof StandardMaterial&&mesh.material.name.includes('bedding-'))mesh.material.diffuseColor=Color3.FromHexString(mesh.material.name.includes('bedding-trim')?bedding.trim:bedding.color);
     const product=productFor(placed.productId),finish=product?.finishes?.find(f=>f.id===placed.finish)??product?.finishes?.[0];
     for(const mesh of model.meshes)if(mesh.material instanceof StandardMaterial&&mesh.material.name.includes('finish-primary')){
      if(finish)mesh.material.diffuseColor=Color3.FromHexString(placed.materialColor??finish.color);
      const clear=placed.productId==='magazine-rack'&&finish?.id==='clear';mesh.material.alpha=clear?.08:1;mesh.material.backFaceCulling=!clear;mesh.material.specularColor=clear?new Color3(.55,.6,.6):Color3.Black();
      mesh.material.specularPower=64;
      if(placed.materialGloss!==undefined){mesh.material.specularColor=Color3.White().scale(placed.materialGloss*.8);mesh.material.specularPower=8+120*placed.materialGloss;}
      if(mesh instanceof Mesh){mesh.outlineWidth=clear?.002:placed.productId==='casalino'||placed.productId==='kd27'?.003:.005;mesh.outlineColor=Color3.FromHexString(clear?'#d2ece8':'#303635');}
     }
    }}
  }
  this.refreshMirrors();
  this.refreshCasters();
 }
 private refreshMirrors():void{
  for(const [id,model] of this.models){
   const glass=model.meshes.find(m=>m.material?.name.includes('mirror-silver'));
   if(!glass||!(glass.material instanceof StandardMaterial))continue;
   let reflection=this.mirrors.get(id);
   if(!reflection){reflection=new MirrorTexture('mirror/'+id,512,this.scene,false,undefined,Texture.NEAREST_SAMPLINGMODE);reflection.refreshRate=0;this.mirrors.set(id,reflection);}
   const backing=model.meshes.find(m=>m.material?.name.includes('mirror-back'));if(!backing)continue;
   glass.computeWorldMatrix(true);backing.computeWorldMatrix(true);
   const center=glass.getBoundingInfo().boundingBox.centerWorld;
   // The isolated glass polygon has no reliable solid-volume winding. The
   // physical backing identifies the room-facing side without a normal guess.
   const inward=backing.getBoundingInfo().boundingBox.centerWorld.subtract(center).normalize();
   reflection.mirrorPlane=Plane.FromPositionAndNormal(center,inward);
   this.mirrorViews.set(id,new MirrorView(this.camera,reflection.mirrorPlane));
   this.mirrorDirty.add(id);
   glass.material.reflectionTexture=reflection;glass.material.diffuseColor=Color3.Black();glass.material.specularColor=new Color3(.25,.25,.25);
   if(glass instanceof Mesh)glass.renderOutline=false;
  }
 }
 update(options:WorldOptions,force=false):void{
  this.options=options;
  const sun=options.sunlight??sunlight(options.hass,options.environment),lights=options.sceneLights??sceneLights(options.items,options.hass,options.environment);
  // Pet simulation includes timers and routes which do not change the rendered pose.
  const cats=options.cats.map(c=>[c.id,c.x,c.z,c.height,c.direction,c.animation,c.frame]);
  const vacuums=options.items.filter(i=>i.productId==='vacuum').map(i=>[i.id,!options.hass||['docked','charging'].includes(options.hass.states[i.entityId]?.state??'')]);
  const lightingKey=JSON.stringify([sun,options.background,lights,options.devices,options.q,options.walls,options.fittings,options.items]);
  const visualKey=JSON.stringify([lightingKey,cats,vacuums,options.selected,options.ghost,options.grid,options.downlights]);
  if(!force&&visualKey===this.visualKey)return;
  this.visualKey=visualKey;this.dirty=true;
  const mirrorDisplayKey=JSON.stringify([options.grid,options.labels]);if(mirrorDisplayKey!==this.mirrorDisplayKey){this.mirrorDisplayKey=mirrorDisplayKey;this.invalidateMirrors();}
  const shadowKey=JSON.stringify([sun.direction,sun.direct>0,options.q,options.walls,options.items,vacuums,options.fittings,options.downlights,lights.map(l=>[l.key,l.x,l.z,l.height,l.direction])]);
  const catShadowKey=JSON.stringify(cats);
  const geometryChanged=force||shadowKey!==this.shadowKey;
  if(geometryChanged)this.settling=true;
  if(options.sceneLights&&!geometryChanged&&lightingKey!==this.lightingKey)this.lightingSettlesAt=performance.now()+150;
  if(geometryChanged){this.shadowKey=shadowKey;this.invalidateShadows();this.shadowCats=options.cats;this.deferredCatShadows=false;}
  else if(catShadowKey!==this.catShadowKey){
   if(options.sceneLights&&(this.lightingInteraction||performance.now()<this.lightingSettlesAt))this.deferredCatShadows=true;
   else this.refreshPetShadows(options.cats);
  }
  const previousCatShadowKey=this.catShadowKey;this.catShadowKey=catShadowKey;
  const changed=options.items!==this.placements;configureCamera(this.camera,options.q);this.updatePlacements(options.items,force);
  for(const part of this.shell.walls){
   const top=options.walls==='low'?Math.min(part.high,.2):part.high;
   const visible=options.walls!=='hidden'&&!(options.walls==='cutaway'&&isWallCutAway(part.wall,options.q))&&top>part.low;
   part.mesh.setEnabled(visible);
   if(visible){part.mesh.scaling.y=(top-part.low)/(part.high-part.low);part.mesh.position.y=(top+part.low)*HEIGHT_SCALE/2;}
  }
  for(const mesh of this.shell.grids)mesh.setEnabled(options.grid);
  for(const fitting of FIXED_FITTINGS){
   const model=this.models.get('fixed/'+fitting.id);if(!model)continue;
   let visible=options.fittings!==false;
   if(fitting.wallNormal){const n=rotateAroundOrigin(fitting.wallNormal,options.q);visible&&=options.walls==='full'||(options.walls==='cutaway'&&(fitting.id!=='overheads'||n.x<0||n.z<0));}
   // Keep upper cabinetry as a shadow blocker even when the cutaway camera hides it.
   model.root.setEnabled(options.fittings!==false);for(const mesh of model.meshes)mesh.layerMask=visible?CAMERA_LAYER:SHADOW_LAYER;
  }
  for(const id of ['pearl','maree']){
   const model=this.models.get('pet/'+id),cat=options.cats.find(c=>c.id===id);if(!model)continue;
   model.root.setEnabled(Boolean(cat));if(!cat)continue;
   model.root.position.set(cat.x,(cat.height??0)*HEIGHT_SCALE,cat.z);model.root.rotation.y=-cat.direction*Math.PI/2;
   const pose=cat.animation+'_'+(cat.frame??0);
   if(this.poses.get(id)===pose)continue;this.poses.set(id,pose);
   for(const mesh of model.meshes)if(mesh instanceof Mesh&&mesh.morphTargetManager){const manager=mesh.morphTargetManager;manager.areUpdatesFrozen=true;for(let i=0;i<manager.numTargets;i++){const t=manager.getTarget(i);t.influence=t.name===pose?1:0;}manager.areUpdatesFrozen=false;}
  }
  for(const item of options.items){
   const model=this.models.get(item.id);if(!model)continue;
   if(productFor(item.productId)?.placement==='entry-door'){
    const normal=rotateAroundOrigin({x:0,z:1},options.q);
    const visible=options.walls==='full'||options.walls==='cutaway'&&(normal.x<0||normal.z<0);
    for(const mesh of model.meshes)mesh.layerMask=visible?CAMERA_LAYER:SHADOW_LAYER;
   }
   if(productFor(item.productId)?.placement==='downlight'){model.root.setEnabled(options.downlights!==false);continue;}
   if(item.productId!=='vacuum')continue;
   model.root.setEnabled(!options.hass||['docked','charging'].includes(options.hass.states[item.entityId]?.state??''));
  }
  if(options.selected!==this.selectedId)this.invalidateMirrors();
  if(force||changed||options.selected!==this.selectedId){
   this.selected?.dispose();this.selected=null;this.selectedId=options.selected;
   const item=options.items.find(i=>i.id===options.selected);if(item)this.selected=this.outline(bounds(item),'#52c7bd');
  }
  const ghostKey=options.ghost?JSON.stringify(options.ghost):'';
  if(force||ghostKey!==this.ghostKey){this.ghostKey=ghostKey;this.invalidateMirrors();
  if(this.ghost){this.remove(this.ghost);this.ghost=null;}
  if(options.ghost){
   this.ghost=this.instantiate('ghost',options.ghost.productId);
   if(this.ghost){this.ghost.root.position.set(options.ghost.x,baseHeight(options.ghost)*HEIGHT_SCALE,options.ghost.z);this.ghost.root.rotation.y=-options.ghost.rotation*Math.PI/2;for(const m of this.ghost.meshes)m.visibility=placeable(options.ghost,options.items)?.45:.18;}
  }
  }
  if(geometryChanged)this.refreshMirrors();
  if(force||lightingKey!==this.lightingKey){this.lightingKey=lightingKey;this.updateLighting(sun,lights);this.invalidateMirrors();}
  else if(catShadowKey!==previousCatShadowKey)this.invalidateMirrors(); // Cats can cast a visible shadow even when outside the reflection.
 }
 pickSurface(x:number,y:number):{owner:string;height:number}|null{
  const hit=this.scene.pick(x,y,m=>m.isEnabled()&&m.isVisible&&m.layerMask===CAMERA_LAYER&&!m.name.startsWith('ghost/')&&!m.name.startsWith('pet/'));
  const data:unknown=hit?.pickedMesh?.metadata;
  if(!hit?.pickedPoint||typeof data!=='object'||data===null||!('itemId'in data)||typeof data.itemId!=='string')return null;
  return {owner:data.itemId.replace(/^fixed\//,''),height:hit.pickedPoint.y/HEIGHT_SCALE};
 }
 pickWallPoint(x:number,y:number):{x:number;z:number}|undefined{
  const hit=this.scene.pick(x,y,m=>m.isEnabled()&&m.isVisible&&this.shell.walls.some(p=>p.mesh===m&&(p.wall.kind==='inner'||p.wall.kind==='outer')));
  return hit?.pickedPoint?{x:hit.pickedPoint.x,z:hit.pickedPoint.z}:undefined;
 }
 private outline(r:Rect,color:string):Mesh{
  const points=[new Vector3(r.x,.008,r.z),new Vector3(r.x+r.w,.008,r.z),new Vector3(r.x+r.w,.008,r.z+r.d),new Vector3(r.x,.008,r.z+r.d),new Vector3(r.x,.008,r.z)];
  const mesh=MeshBuilder.CreateLines('selected',{points},this.scene);mesh.color=Color3.FromHexString(color);return mesh;
 }
 private updateLighting(sun:Sunlight,lights:SceneLight[]):void{
  if(!this.options)return;const o=this.options;
  this.sky.intensity=.12+sun.daylight*.55;this.sky.diffuse=Color3.Lerp(new Color3(.38,.48,.78),new Color3(1,.96,.88),sun.daylight);
  this.sun.direction.set(sun.direction.x,sun.direction.y,sun.direction.z);this.sun.position.copyFrom(new Vector3(CENTER.x,0,CENTER.z).subtract(this.sun.direction.scale(24)));
  this.sun.intensity=sun.direct;this.sun.setEnabled(sun.direct>0);this.sun.diffuse=sun.elevation<12?new Color3(1,.62,.32):new Color3(1,.94,.83);
  this.scene.clearColor=this.options?.background==='light'?new Color4(1,1,1,1):this.options?.background==='dark'?new Color4(0,0,0,1):Color4.Lerp(new Color4(.055,.075,.14,1),new Color4(.525,.831,.91,1),sun.daylight);
  const keys=new Set(lights.map(l=>l.key));
  for(const [key,bound] of this.sources)if(!keys.has(key)){bound.cache?.dispose();bound.shadow.dispose();bound.light.dispose();bound.bulb.dispose();bound.material.dispose();this.sources.delete(key);}
  for(const value of lights){
   let source=this.sources.get(value.key);
   if(!source){
    const position=new Vector3(value.x,value.height*HEIGHT_SCALE,value.z);
    const direction=value.direction?new Vector3(value.direction.x,value.direction.y,value.direction.z):new Vector3(0,-1,0);
    const light=value.kind==='spot'?new SpotLight(value.key,position,direction,Math.PI*.82,1,this.scene):new PointLight(value.key,position,this.scene);
    light.range=value.range??6;light.falloffType=Light.FALLOFF_GLTF;light.shadowMinZ=.06;light.shadowMaxZ=8;
    const shadow=new ShadowGenerator(value.kind==='spot'?512:256,light,false,undefined,this.redShadowTextures);shadow.forceBackFacesOnly=true;shadow.bias=.001;shadow.normalBias=0;if(value.kind==='spot'){shadow.usePercentageCloserFiltering=true;shadow.filteringQuality=ShadowGenerator.QUALITY_LOW;}
    const bulb=value.stripLength?MeshBuilder.CreateBox('strip/'+value.key,{width:.022,height:.009*HEIGHT_SCALE,depth:value.stripLength},this.scene):MeshBuilder.CreateSphere('bulb/'+value.key,{diameter:.095,segments:6},this.scene),material=new StandardMaterial(value.stripLength?'kitchen-strip-diffuser':'bulb-material',this.scene);bulb.material=material;bulb.layerMask=CAMERA_LAYER;material.disableLighting=true;
    source={...this.shadowCachePool?{cache:new StaticShadowCache(this.shadowCachePool,shadow)}:{},light,shadow,bulb,material,...value.ownerId?{ownerId:value.ownerId}:{}};this.sources.set(value.key,source);
   }
   if(source.light instanceof SpotLight&&value.direction)source.light.direction.set(value.direction.x,value.direction.y,value.direction.z);
   source.light.position.set(value.x,value.height*HEIGHT_SCALE,value.z);source.light.diffuse=rgb(value.color);source.light.intensity=value.brightness*.8*(value.power??1);source.light.setEnabled(o.sceneLights!==undefined||value.brightness>0);
   if(source.shadowStale&&source.light.intensity>0){source.shadow.getShadowMap()?.resetRefreshCounter();source.shadowStale=false;}
   source.bulb.position.copyFrom(source.light.position);
   const stripVisible=value.stripLength&&this.models.get('fixed/overheads')?.meshes.some(m=>m.isEnabled()&&m.layerMask===CAMERA_LAYER);
   source.bulb.setEnabled(!value.screen&&(value.stripLength?Boolean(stripVisible):value.brightness>0&&((o.devices&&!value.ownerId)||value.kind==='point')));source.material.emissiveColor=rgb(value.color).scale(value.stripLength?value.brightness:1);source.material.disableLighting=!value.stripLength||value.brightness>0;source.material.diffuseColor=Color3.FromHexString('#e5e3dc');
   // Lampshades remain visibly lit while the same physical source lights the room.
   const lamp=this.models.get(value.ownerId??value.key);if(lamp)for(const mesh of lamp.meshes)if(mesh.material instanceof StandardMaterial){const m=mesh.material;const diffuser=/lamp-diffuser-(\d+)-(\d+)/.exec(m.name);
    const shade=Boolean(diffuser)||m.name.includes('surface-#fff5d6-lit')||m.name.includes('lamp-bulb')||m.name.includes('diffuser-lit');
    const band=Number(diffuser?.[1]??0),fold=Number(diffuser?.[2]??0),height=.27+(band+.5)*1.27/12;
    const distance=Math.min(...[.52,.90,1.28].map(h=>Math.abs(h-height)));
    const gain=diffuser?(.68+.27*Math.exp(-((distance/.18)**2)))*(fold===0?1:.79):.95;
    // A dim diffuser still reflects room light. Disabling lighting makes its
    // white plastic/paper disappear into the near-black emissive colour.
    m.disableLighting=false;m.emissiveColor=shade?rgb(value.color).scale(value.brightness*gain):Color3.Black();
    if(m.name.includes('dejsa-diffuser-lit')){
     // Opal glass looks luminous even when dimmed. This display response does not
     // increase the point light's output or change the Home Assistant brightness.
     m.emissiveColor=Color3.Lerp(rgb(value.color),Color3.White(),.55).scale(1.55*Math.sqrt(value.brightness));
    }
   }
  }
  // Brightness and colour are uniforms; they do not change cached shadow geometry.
  const casterGeometryKey=JSON.stringify([lights.map(l=>[l.key,l.ownerId,l.x,l.z,l.height,l.direction,l.range]),o.items,o.fittings,this.scene.meshes.length]);
  if(casterGeometryKey!==this.casterGeometryKey){this.casterGeometryKey=casterGeometryKey;this.refreshCasters();}
  // Public sliders keep a fixed set of shader light slots, including zero-intensity sources.
  const selectionKey=JSON.stringify([casterGeometryKey,o.sceneLights?true:lights.map(l=>l.brightness>0),sun.direct>0,o.q,o.walls,o.downlights]);
  if(selectionKey!==this.lightSelectionKey){this.lightSelectionKey=selectionKey;this.settling=true;
   const nominal=o.sceneLights?new Map(lights.flatMap(value=>{const source=this.sources.get(value.key);return source?[[source.light,.8*(value.power??1)] satisfies [PointLight|SpotLight,number]]:[];})):undefined;
   prioritizeRoomLights(this.scene,nominal);}
 }
 pickItem(x:number,y:number):string|null{
  const hit=this.scene.pick(x,y,m=>{const data:unknown=m.metadata;return typeof data==='object'&&data!==null&&'itemId'in data&&typeof data.itemId==='string'&&!data.itemId.startsWith('fixed/')&&!data.itemId.startsWith('pet/')&&data.itemId!=='ghost';});
  const data:unknown=hit?.pickedMesh?.metadata;
  return typeof data==='object'&&data!==null&&'itemId'in data&&typeof data.itemId==='string'?data.itemId:null;
 }
 private updateTelevision(now:number):void{
  const options=this.options;if(!options)return;
  const mode=televisionMode(options.hass,options.environment.mode!=='live'&&options.environment.previewLights),frame=this.televisionClock.advance(now,mode),key=mode+'/'+frame;
  if(key===this.televisionFrame&&!this.dirty)return;
  if(this.televisionFrame.split('/')[0]!==mode)this.settling=true;
  const screens=[...this.models.values()].filter(m=>m.model==='lg-g4').flatMap(m=>m.meshes).filter(m=>m.isEnabled()).map(m=>m.material).filter(m=>m instanceof StandardMaterial).filter(m=>m.name.includes('screen-lit'));
  if(!screens.length){this.televisionFrame=key;return;}
  if(key!==this.televisionFrame){this.dirty=true;this.invalidateMirrors([...this.models.values()].filter(m=>m.model==='lg-g4').flatMap(m=>m.meshes));}
  if(!this.televisionTexture){this.settling=true;this.televisionTexture=RawTexture.CreateRGBATexture(televisionPixels(mode,frame),TV_WIDTH,TV_HEIGHT,this.scene,false,false,Texture.NEAREST_SAMPLINGMODE);this.televisionTexture.name='Apple TV pixel picture';this.televisionTexture.uScale=-1;this.televisionTexture.uOffset=1;this.televisionTexture.vScale=-1;this.televisionTexture.vOffset=1;this.televisionTexture.gammaSpace=true;this.televisionFrame=key;}
  else if(this.televisionFrame!==key){this.televisionTexture.update(televisionPixels(mode,frame));this.televisionFrame=key;}
  for(const material of screens){material.emissiveTexture=mode==='off'?null:this.televisionTexture;material.diffuseColor=Color3.FromHexString('#111a1d');material.disableLighting=mode!=='off';material.emissiveColor=mode==='off'?Color3.Black():Color3.White().scale(mode==='idle'?.65:1);}
 }
 private refreshPetShadows(cats:WorldOptions['cats']):void{
  this.sunShadow.getShadowMap()?.resetRefreshCounter();
  // Retain the last rendered footprints, including cats that have moved away.
  const footprints=[...this.shadowCats,...cats];
  for(const source of this.sources.values())if(footprints.some(c=>{
   const dx=c.x-source.light.position.x,dz=c.z-source.light.position.z,dy=(c.height??0)*HEIGHT_SCALE-source.light.position.y;
   return dx*dx+dy*dy+dz*dz<(source.light.range+.65)**2;
  })){
   if(source.light.intensity>0)source.shadow.getShadowMap()?.resetRefreshCounter();
   else source.shadowStale=true;
  }
  this.shadowCats=cats;this.deferredCatShadows=false;
 }
 /** Shadow textures depend on geometry and light transforms, not each TV frame. */
 private invalidateShadows():void{
  for(const source of this.sources.values())source.cache?.invalidate();
  this.sunShadow.getShadowMap()?.resetRefreshCounter();
  for(const source of this.sources.values()){if(source.light.intensity>0)source.shadow.getShadowMap()?.resetRefreshCounter();else source.shadowStale=true;}
 }
 contextRestored():void{for(const source of this.sources.values())source.cache?.dispose();this.settling=true;this.invalidate();}
 invalidate():void{this.dirty=true;this.invalidateShadows();this.invalidateMirrors();}
 setPresentationPaused(paused:boolean):void{this.presentationPaused=paused;}
 setLightingInteraction(active:boolean):void{this.lightingInteraction=active;if(!active)this.lightingSettlesAt=performance.now()+150;}
 render(now=performance.now()):void{
  if(this.disposed||this.presentationPaused)return;
  if(this.deferredCatShadows&&!this.lightingInteraction&&now>=this.lightingSettlesAt&&this.options){this.refreshPetShadows(this.options.cats);this.dirty=true;}
  const reflectionsReady=!this.lightingInteraction&&now>=this.lightingSettlesAt;
  if(reflectionsReady&&this.mirrorDirty.size)this.dirty=true;
  this.updateTelevision(now);
  this.updateCatClocks(now);
  // Keep rendering through shader compilation, including asynchronous GLB loading.
  if(!this.dirty&&!this.settling)return;
  enforceLightBudget(this.scene);
  for(const [id,mirror] of this.mirrors)if((reflectionsReady&&this.mirrorDirty.has(id))||this.settling){
   const view=this.mirrorViews.get(id);
   mirror.renderList=this.scene.meshes.filter(m=>m.layerMask===CAMERA_LAYER&&!m.material?.name.includes('mirror-silver')&&!this.models.get(id)?.meshes.includes(m)&&view?.sees(m));
   mirror.resetRefreshCounter();
  }
  if(reflectionsReady)this.mirrorDirty.clear();
  const ready=!this.settling||this.scene.isReady();this.scene.render();this.dirty=false;this.settling=!ready;
 }
 private updateCatClocks(now:number):void{
  const swing=Math.round(Math.sin(now*Math.PI*2/1800)*12)/12;
  let changed=false;
  for(const model of this.models.values())if(model.model==='orange-cat-clock'){
   for(const mesh of model.meshes)if(mesh instanceof Mesh&&mesh.morphTargetManager){
    const manager=mesh.morphTargetManager;manager.areUpdatesFrozen=true;
    for(let i=0;i<manager.numTargets;i++){
     const target=manager.getTarget(i),weight=target.name==='clock-left'?Math.max(0,-swing):target.name==='clock-right'?Math.max(0,swing):0;
     if(target.influence!==weight){target.influence=weight;changed=true;}
    }
    manager.areUpdatesFrozen=false;
   }
  }
  if(changed){this.dirty=true;this.invalidateMirrors([...this.models.values()].filter(m=>m.model==='orange-cat-clock').flatMap(m=>m.meshes));}
 }
 dispose():void{this.disposed=true;this.loadAbort.abort();for(const source of this.sources.values())source.cache?.dispose();for(const model of this.models.values())this.remove(model);for(const template of this.templates.values())template.dispose();this.scene.dispose();}
}
export function startApartmentWorld(canvas:HTMLCanvasElement,options:GraphicsRuntimeOptions={}):{world:ApartmentWorld;dispose:()=>void}{
 const engine=new Engine(canvas,false,{preserveDrawingBuffer:true,stencil:true},false);engine.setSize(WIDTH,HEIGHT);
 // A failed VAO allocation can be bypassed without changing any scene detail.
 // Set this before geometries/post-processes are constructed, including on restore.
 if(options.disableVertexArrayObjects){engine.disableVertexArrayObjects=true;engine.getCaps().vertexArrayObject=false;}
 let world:ApartmentWorld;try{world=new ApartmentWorld(engine);}catch(error){engine.dispose();throw error;}
 let last=0,visible=true,disposed=false,failed=false,recoveryTimer:ReturnType<typeof setTimeout>|undefined;
 const gl=canvas.getContext('webgl2')??canvas.getContext('webgl');
 const fail=(error:unknown)=>{if(disposed||failed)return;failed=true;clearTimeout(recoveryTimer);engine.stopRenderLoop(draw);options.onRenderError?.(error);};
 const draw=()=>{
  const now=performance.now();if(disposed||failed||canvas.clientWidth===0||now-last<32)return;last=now;
  try{world.render(now);}catch(error){
   // Context loss may happen during a draw, before its DOM event is delivered.
   // Never let it escape the callback: Babylon would stop scheduling frames.
   if(gl?.isContextLost()){engine.stopRenderLoop(draw);return;}
   fail(error);
  }
 };
 const visibility=()=>{
  engine.stopRenderLoop(draw);
  if(!disposed&&!failed&&!document.hidden&&visible){world.invalidate();last=0;engine.runRenderLoop(draw);}
 };
 engine.onContextLostObservable.add(()=>{
  engine.stopRenderLoop(draw);clearTimeout(recoveryTimer);
  recoveryTimer=setTimeout(()=>fail(new Error('WebGL context did not recover')),CONTEXT_RECOVERY_TIMEOUT_MS);
 });
 engine.onContextRestoredObservable.add(()=>{if(disposed||failed)return;clearTimeout(recoveryTimer);world.contextRestored();visibility();});
 const observer=new IntersectionObserver(([entry])=>{if(entry&&entry.isIntersecting!==visible){visible=entry.isIntersecting;visibility();}});
 observer.observe(canvas);document.addEventListener('visibilitychange',visibility);visibility();
 return{world,dispose:()=>{disposed=true;clearTimeout(recoveryTimer);observer.disconnect();document.removeEventListener('visibilitychange',visibility);engine.stopRenderLoop();world.dispose();engine.dispose();}};
}
export function projectedWorld(camera:FreeCamera,p:Vector3):Vector3{return Vector3.Project(p,Matrix.Identity(),camera.getTransformationMatrix(),camera.viewport.toGlobal(WIDTH,HEIGHT));}
export {DEFAULT_ENVIRONMENT};
