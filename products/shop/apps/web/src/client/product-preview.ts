import flats from '@/lib/flat-preview-templates.json';
import { renderRecursiveImage, type EditorSettings } from '@/lib/recursive-image';
import { PRODUCT_MOCKUP_GEOMETRY } from '@forever-tee/contracts/product-mockup-geometry';
import type { BaseProductSlug } from '@forever-tee/contracts/product-projection';

export interface PreviewRecipe {
  revision: string;
  baseProductSlug: BaseProductSlug;
  settings: EditorSettings;
}
interface PreviewSource { recipe: PreviewRecipe; image: ImageBitmap }
const sources = new Map<string, Promise<PreviewSource>>();

function parseRecipe(value: unknown): PreviewRecipe {
  if (typeof value !== 'object' || value === null || !('revision' in value) || typeof value.revision !== 'string' ||
    !('baseProductSlug' in value) || (value.baseProductSlug !== 'staple-tee' && value.baseProductSlug !== 'cotton-tote') ||
    !('settings' in value) || typeof value.settings !== 'object' || value.settings === null) throw new Error('Invalid preview recipe.');
  const s = value.settings;
  if (!('cropX' in s) || typeof s.cropX !== 'number' || !('cropY' in s) || typeof s.cropY !== 'number' ||
    !('cropZoom' in s) || typeof s.cropZoom !== 'number' || !('depth' in s) || typeof s.depth !== 'number' ||
    !('placementX' in s) || typeof s.placementX !== 'number' || !('placementY' in s) || typeof s.placementY !== 'number' ||
    !('placementWidth' in s) || typeof s.placementWidth !== 'number' ||
    ![s.cropX,s.cropY,s.cropZoom,s.depth,s.placementX,s.placementY,s.placementWidth].every(Number.isFinite) ||
    s.depth < 0 || s.depth > 12 || s.cropZoom <= 0 || s.cropZoom > 10) throw new Error('Invalid preview placement.');
  return {revision:value.revision,baseProductSlug:value.baseProductSlug,settings:{cropX:s.cropX,cropY:s.cropY,cropZoom:s.cropZoom,
    depth:s.depth,placementX:s.placementX,placementY:s.placementY,placementWidth:s.placementWidth}};
}

export function retainProductPreview(productId: string, recipe: PreviewRecipe, source: ImageBitmap) {
  // Own a separate bitmap: the editor can release its copy after navigation.
  const pending = createImageBitmap(source).then(image => ({recipe,image}));
  remember(`${productId}/${recipe.revision}`,pending);
}
function remember(key: string, pending: Promise<PreviewSource>) {
  sources.set(key,pending);
  const expire = () => {
    if (sources.get(key) !== pending) return;
    sources.delete(key);
    void pending.then(source => {source.image.close();}, () => undefined);
  };
  window.setTimeout(expire,300_000);
  void pending.catch(expire);
  // Keep a small number of in-flight/saved designs, never persist portraits.
  if (sources.size > 4) {
    const first = sources.keys().next().value;
    if (first && first !== key) {
      const previous=sources.get(first); sources.delete(first);
      void previous?.then(source => {source.image.close();}, () => undefined);
    }
  }
}
export function loadProductPreview(productId: string, revision: string) {
  const key=`${productId}/${revision}`;
  const existing=sources.get(key);
  if(existing) return existing;
  const pending=(async()=>{
    const response=await fetch(`/api/product-preview/${encodeURIComponent(productId)}/${encodeURIComponent(revision)}`,{cache:'no-store',signal:AbortSignal.timeout(8_000)});
    if(!response.ok) throw new Error('Preview source unavailable.');
    const value:unknown=JSON.parse(response.headers.get('x-product-preview') ?? 'null');
    const recipe=parseRecipe(value);
    if(recipe.revision!==revision) throw new Error('Preview revision changed.');
    return {recipe,image:await createImageBitmap(await response.blob())};
  })();
  remember(key,pending);
  return pending;
}
export function placedArtwork(source: PreviewSource, width: number) {
  const geometry=PRODUCT_MOCKUP_GEOMETRY[source.recipe.baseProductSlug];
  const canvas=document.createElement('canvas');
  canvas.width=width; canvas.height=Math.round(width*geometry.canvas.heightPx/geometry.canvas.widthPx);
  renderRecursiveImage(canvas,source.image,source.recipe.settings);
  return canvas;
}
const flatImages=new Map<string,Promise<HTMLImageElement>>();
function loadFlat(slug:BaseProductSlug,color:string) {
  const path=slug==='staple-tee' ? (color.toLowerCase()==='white' ? flats['tee-white-v1.png'] : flats['tee-black-v1.png']) :
    (color.toLowerCase()==='cream' ? flats['tote-cream-print-bar-1001.webp'] : flats['tote-black-print-bar-1001.webp']);
  let pending=flatImages.get(path);
  if(!pending){const image=new Image();image.src=path;pending=image.decode().then(()=>image);flatImages.set(path,pending);void pending.catch(()=>{flatImages.delete(path);});}
  return pending;
}
export async function renderFlatPreview(canvas: HTMLCanvasElement, productId: string, revision: string, color: string, slug?:BaseProductSlug) {
  const pendingSource=loadProductPreview(productId,revision);
  const [source,base]=await Promise.all([pendingSource,
    slug ? loadFlat(slug,color) : pendingSource.then(source=>loadFlat(source.recipe.baseProductSlug,color))]);
  if(slug && source.recipe.baseProductSlug!==slug)throw new Error('Preview product changed.');
  const geometry=PRODUCT_MOCKUP_GEOMETRY[source.recipe.baseProductSlug];
  canvas.width=768; canvas.height=768;
  const context=canvas.getContext('2d');
  if(!context) throw new Error('Canvas unavailable.');
  context.drawImage(base,0,0,768,768);
  context.drawImage(placedArtwork(source,Math.round(768*geometry.mockup.width)),Math.round(768*geometry.mockup.left),Math.round(768*geometry.mockup.top));
}
