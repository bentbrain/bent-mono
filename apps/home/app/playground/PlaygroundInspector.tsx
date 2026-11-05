import {X} from 'lucide-react';
import {BEDDING,baseHeight,productFor,type Item,type Product} from '../editorState';
import {placementSurfaces} from '../surfaces';
import {onSurface} from '../placement';
import {surfacePosition,slideOnSurface} from '../surfacePosition';

interface Props {item:Item;items:Item[];product:Product;onChange:(item:Item)=>void;onClose:()=>void}

export function PlaygroundInspector({item,items,product,onChange,onClose}:Props){
 const color=item.materialColor??product.finishes?.find(f=>f.id===item.finish)?.color??product.finishes?.[0]?.color??'#ffffff';
 const support=surfacePosition(item,items);
 return <section className="playground-inspector" aria-label="Edit selected item">
  <div className="inspector-heading"><h2>{product.name}</h2><button onClick={onClose} aria-label="Close item editor"><X size={18}/></button></div>
  <div className="inspector-fields">
   {!!product.finishes?.length&&<><label>Finish<select value={item.finish??product.finishes[0]?.id} onChange={e=>{const next={...item,finish:e.target.value};delete next.materialColor;onChange(next);}}>{product.finishes.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label>Colour<input type="color" value={color} onChange={e=>onChange({...item,materialColor:e.target.value})}/></label></>}
   {product.id==='kirribilli'&&<label>Bedding<select value={item.bedding??BEDDING[0]?.id} onChange={e=>onChange({...item,bedding:e.target.value})}>{BEDDING.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
   {product.id==='casalino'&&<label><input type="checkbox" checked={item.seatPad??false} onChange={e=>onChange({...item,seatPad:e.target.checked})}/>Seat cushion</label>}
  </div>
  <details className="inspector-advanced"><summary>Details & position</summary>
   <p>{Math.round(product.w*100)} × {Math.round(product.d*100)} × {Math.round(product.h*100)} cm</p>
   <div className="inspector-fields"><label>X · m<input type="number" aria-label="Item X position" step="0.05" value={item.x} onChange={e=>{if(e.target.value!=='')onChange({...item,x:e.target.valueAsNumber});}}/></label><label>Y · m<input type="number" aria-label="Item Y position" step="0.05" value={item.z} onChange={e=>{if(e.target.value!=='')onChange({...item,z:e.target.valueAsNumber});}}/></label>
    {(product.placement==='small'||product.placement==='wall'||product.placement==='ceiling')&&<label>Height · cm<input type="number" min={0} max={Math.round((2.7-product.h)*100)} step={1} value={Math.round(baseHeight(item)*100)} onChange={e=>{if(e.target.value!==''){const next={...item,elevation:e.target.valueAsNumber/100};delete next.supportId;delete next.supportSurface;onChange(next);}}}/></label>}
   </div>
   {product.placement==='small'&&<label>Surface<select aria-label="Place on a surface" value="" onChange={e=>{const surface=placementSurfaces(items).find(s=>s.id===e.target.value);if(surface)onChange(onSurface(item,surface));}}><option value="">Choose a surface</option>{placementSurfaces(items).filter(s=>s.owner!==item.id&&s.use==='top'&&!items.some(i=>i.id===s.owner&&i.supportId===item.id)).map(s=><option key={s.id} value={s.id}>{productFor(items.find(i=>i.id===s.owner)?.productId??'')?.name??s.owner} · {Math.round(s.height*100)} cm</option>)}</select></label>}
   {support&&<><label>Side to side<input aria-label="Side to side on surface" type="range" min={-Math.floor(support.maxX*100)} max={Math.floor(support.maxX*100)} value={Math.round(support.x*100)} onChange={e=>onChange(slideOnSurface(item,items,e.target.valueAsNumber/100,support.z))}/></label><label>Front to back<input aria-label="Front to back on surface" type="range" min={-Math.floor(support.maxZ*100)} max={Math.floor(support.maxZ*100)} value={Math.round(support.z*100)} onChange={e=>onChange(slideOnSurface(item,items,support.x,e.target.valueAsNumber/100))}/></label></>}
   {!!product.finishes?.length&&<><label className="inspector-gloss">Gloss<input type="range" min={0} max={100} value={Math.round((item.materialGloss??0)*100)} onChange={e=>onChange({...item,materialGloss:e.target.valueAsNumber/100})}/></label><button disabled={item.materialColor===undefined&&item.materialGloss===undefined} onClick={()=>{const next={...item};delete next.materialColor;delete next.materialGloss;onChange(next);}}>Reset finish</button></>}
   {product.url&&<a href={product.url} target="_blank" rel="noreferrer">Product details ↗</a>}
  </details>
 </section>;
}
