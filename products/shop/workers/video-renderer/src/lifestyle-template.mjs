import {PRODUCT_MOCKUP_GEOMETRY_VERSION} from './product-mockup-geometry.mjs';

/** Resolve photo-space assets independently from the product-space print canvas. */
export async function loadLifestyleTemplate(manifest,colour,readAsset) {
  if (manifest?.version!==1 || manifest.product?.slug!=='staple-tee' ||
    manifest.product.geometryVersion!==PRODUCT_MOCKUP_GEOMETRY_VERSION ||
    !['white','black'].includes(colour) || !Array.isArray(manifest.templates)) {
    throw new Error('Lifestyle template does not match the product print geometry.');
  }
  const matches=manifest.templates.filter(template=>template.id===colour);
  if (matches.length!==1 || typeof matches[0].mask!=='string' ||
    !/^[a-z0-9][a-z0-9.-]*\.(png|svg)$/.test(matches[0].mask)) {
    throw new Error('A unique lifestyle template with a garment mask is required.');
  }
  const mask=await readAsset(matches[0].mask);
  if (!Buffer.isBuffer(mask) || !mask.length) throw new Error('Lifestyle garment mask unavailable.');
  return {...matches[0],mask};
}
