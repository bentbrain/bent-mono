import sharp from 'sharp';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
// Decoded pixels are bytes. Reuse their exact linear-light values instead of
// repeating the exponent for every bilinear sample and background channel.
const linearBytes = Float64Array.from({length:256},(_,value)=>(value/255)**2.2);
const linear = value => linearBytes[value];
const encoded = value => Math.round(clamp(value, 0, 1) ** (1 / 2.2) * 255);

// Three separable box passes approximate a Gaussian in floating point. Blurring
// an 8-bit black photo first quantizes its tiny gradients into visible warp steps.
function smoothLuminance(source,width,height,radius) {
  const r=Math.max(1,Math.round(radius)),divisor=2*r+1;
  let pixels=Float32Array.from(source);
  const horizontal=new Float32Array(pixels.length),vertical=new Float32Array(pixels.length);
  for (let pass=0;pass<3;pass++) {
    for (let y=0;y<height;y++) {
      const row=y*width;
      let sum=0;
      for(let k=-r;k<=r;k++) sum+=pixels[row+clamp(k,0,width-1)];
      for(let x=0;x<width;x++) {
        horizontal[row+x]=sum/divisor;
        sum+=pixels[row+clamp(x+r+1,0,width-1)]-pixels[row+clamp(x-r,0,width-1)];
      }
    }
    for (let x=0;x<width;x++) {
      let sum=0;
      for(let k=-r;k<=r;k++) sum+=horizontal[clamp(k,0,height-1)*width+x];
      for(let y=0;y<height;y++) {
        vertical[y*width+x]=sum/divisor;
        sum+=horizontal[clamp(y+r+1,0,height-1)*width+x]-horizontal[clamp(y-r,0,height-1)*width+x];
      }
    }
    pixels=vertical;
  }
  return pixels;
}

// Inverse projective transform from a clockwise quadrilateral to the unit square.
function inverseQuad(quad) {
  const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] = quad;
  const dx1=x1-x2, dx2=x3-x2, dx3=x0-x1+x2-x3;
  const dy1=y1-y2, dy2=y3-y2, dy3=y0-y1+y2-y3;
  const denominator=dx1*dy2-dx2*dy1;
  if (Math.abs(denominator)<1e-8) throw new Error('Print quadrilateral is degenerate.');
  const g=(dx3*dy2-dx2*dy3)/denominator, h=(dx1*dy3-dx3*dy1)/denominator;
  const a=x1-x0+g*x1, b=x3-x0+h*x3, c=x0;
  const d=y1-y0+g*y1, e=y3-y0+h*y3, f=y0;
  const matrix=[e-f*h,c*h-b,b*f-c*e,f*g-d,a-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d];
  return (x,y) => {
    const divisor=matrix[6]*x+matrix[7]*y+matrix[8];
    return [(matrix[0]*x+matrix[1]*y+matrix[2])/divisor,
      (matrix[3]*x+matrix[4]*y+matrix[5])/divisor];
  };
}

function validate(options) {
  if (!Array.isArray(options.lightTint) || options.lightTint.length!==3 ||
      !options.lightTint.every(value=>Number.isFinite(value) && value>=.8 && value<=1.2)) {
    throw new Error('Light tint must contain three RGB gains between 0.8 and 1.2.');
  }
  if (!Array.isArray(options.quad) || options.quad.length !== 4 ||
      !options.quad.every(point => Array.isArray(point) && point.length === 2 &&
        point.every(value => Number.isFinite(value) && value >= 0 && value <= 1))) {
    throw new Error('Four normalized print corners are required: top left, top right, bottom right, bottom left.');
  }
  for (let i=0;i<4;i++) {
    const a=options.quad[i],b=options.quad[(i+1)%4],c=options.quad[(i+2)%4];
    if ((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]) <= 0.00001) {
      throw new Error('Print corners must form a convex clockwise quadrilateral.');
    }
  }
  for (const [key,min,max] of [['displacement',0,80],['shading',0,1],['texture',0,1],['lightReference',0.01,1],
    ['highlights',0,1],['foldContrast',0,3],['inkSoftness',0,1]]) {
    if (!Number.isFinite(options[key]) || options[key]<min || options[key]>max) throw new Error(`Invalid ${key}.`);
  }
}

// Interpolate premultiplied colour so hidden RGB in transparent pixels cannot form halos.
function sampleArtwork(data,width,height,u,v) {
  const x=u*width-0.5,y=v*height-0.5,left=Math.floor(x),top=Math.floor(y);
  const result=[0,0,0,0];
  for (let j=0;j<2;j++) for (let i=0;i<2;i++) {
    const px=left+i,py=top+j;
    if (px<0 || py<0 || px>=width || py>=height) continue;
    const weight=(i?x-left:1-x+left)*(j?y-top:1-y+top),offset=(py*width+px)*4;
    const alpha=data[offset+3]/255*weight;
    result[3]+=alpha;
    for (let c=0;c<3;c++) result[c]+=linear(data[offset+c])*alpha;
  }
  return result;
}

/** Local deterministic compositor. Artwork must already include its crop and recursion.
 * Geometry comes from the calibrated quad; luminance-derived folds are an approximation,
 * not recovered 3D geometry. A supplied two-channel map can replace that approximation.
 */
export async function renderLifestyle({base,artwork,lighting=base,mask,displacementMap,
  highlights=0,foldContrast=1,inkSoftness=0,lightTint=[1,1,1],diagnostics=true,compile=false,format="png",...settings}) {
  const options={...settings,highlights,foldContrast,inkSoftness,lightTint};
  validate(options);
  // Template illumination only: never grade the source or already-balanced photo.
  const tint=lightTint.map(gain=>gain**2.2);
  const {data:background,info}=await sharp(base,{limitInputPixels:24_000_000}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {width,height}=info;
  const geometryMap=compile ? Buffer.alloc(width*height*3) : undefined;
  const lightMap=compile ? Buffer.alloc(width*height*3) : undefined;
  const sizeScale=width/1086;
  const projectedWidth=Math.max(...[0,2].map(index=>{
    const a=options.quad[index],b=options.quad[index+1];
    return Math.hypot((a[0]-b[0])*width,(a[1]-b[1])*height);
  }));
  // Prefilter before minification. Sampling a 1000 px print into a 300 px chest
  // without this step makes fine details and displaced edges look jagged.
  const inkImage=sharp(artwork,{limitInputPixels:24_000_000}).rotate().toColourspace('srgb').ensureAlpha()
    .resize({width:Math.max(1,Math.ceil(projectedWidth*2)),withoutEnlargement:true});
  if (inkSoftness>0) inkImage.blur(Math.max(.3,inkSoftness*2));
  const {data:ink,info:inkInfo}=await inkImage.raw().toBuffer({resolveWithObject:true});
  const light=sharp(lighting).rotate().resize(width,height,{fit:'fill'}).removeAlpha().greyscale();
  const [fine,matte,map]=await Promise.all([
    light.raw().toBuffer(),
    mask ? sharp(mask).rotate().flatten({background:'#000000'}).greyscale().raw().toBuffer({resolveWithObject:true}) : undefined,
    displacementMap ? sharp(displacementMap).resize(width,height).removeAlpha().toColourspace('srgb').raw().toBuffer() : undefined,
  ]);
  if (matte && (matte.info.width!==width || matte.info.height!==height || matte.info.channels!==1)) {
    throw new Error('Garment mask must match the oriented photograph dimensions.');
  }
  const soft=smoothLuminance(fine,width,height,2*sizeScale);
  const broad=smoothLuminance(fine,width,height,32*sizeScale);
  const folds=smoothLuminance(fine,width,height,5*sizeScale);
  const inverse=inverseQuad(options.quad.map(([x,y])=>[x*width,y*height]));
  const output=Buffer.from(background),diagnostic=Buffer.alloc(width*height*3,128);
  const shadowMap=Buffer.alloc(width*height,255),highlightMap=Buffer.alloc(width*height);
  const at=(data,x,y)=>data[clamp(y,0,height-1)*width+clamp(x,0,width-1)]/255;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const index=y*width+x;
    // Local contrast removes the cloth's base colour while retaining its folds.
    // Blur the geometry more than the lighting so fabric grain cannot zigzag edges.
    const reference=Math.max(broad[index]/255,options.lightReference*.4);
    const fold=(folds[index]-broad[index])/255/reference;
    const dx=map ? (map[index*3]-128)/127*options.displacement*sizeScale :
      clamp((fold+1.5*(at(folds,x+3,y)-at(folds,x-3,y))/reference)*options.displacement*sizeScale,-12*sizeScale,12*sizeScale);
    const dy=map ? (map[index*3+1]-128)/127*options.displacement*sizeScale :
      clamp((fold*.25+1.5*(at(folds,x,y+3)-at(folds,x,y-3))/reference)*options.displacement*sizeScale,-8*sizeScale,8*sizeScale);
    diagnostic[index*3]=clamp(Math.round(128+dx*12),0,255);
    diagnostic[index*3+1]=clamp(Math.round(128+dy*12),0,255);
    const [u,v]=inverse(x+0.5+dx,y+0.5+dy);
    if (u<0 || v<0 || u>1 || v>1) continue;
    const sampled=sampleArtwork(ink,inkInfo.width,inkInfo.height,u,v);
    // Clip at the destination pixel after warping. Displacing this mask with the
    // artwork would move the shirt boundary and let ink spill onto skin again.
    const coverage=(matte ? matte.data[index]/255 : 1)*(background[index*4+3]/255);
    const alpha=sampled[3]*coverage;
    if (alpha<=0) continue;
    const illumination=soft[index]/255/options.lightReference;
    const localRatio=soft[index]/Math.max(broad[index],255*options.lightReference*.4);
    // Multiply shadow transmission, then screen a separate reflected-light layer.
    // The second layer can brighten even pure black ink; multiplication cannot.
    const shadow=clamp(illumination,.4,1)**(options.shading*1.3)*
      clamp(localRatio,.5,1)**(options.shading*options.foldContrast);
    const fibre=clamp((fine[index]-soft[index])/Math.max(broad[index],255*options.lightReference*.4),-.15,.15)*options.texture;
    const sheen=clamp(Math.max(0,illumination-1)*.035+Math.max(0,localRatio-1)*.12+
      Math.max(0,fibre)*.02,0,.12)*options.highlights;
    if (compile) {
      // Opaque RGB maps avoid browser premultiplication of data channels.
      const pu=Math.round(u*4095),pv=Math.round(v*4095);
      geometryMap[index*3]=pu>>4;
      geometryMap[index*3+1]=((pu&15)<<4)|(pv>>8);
      geometryMap[index*3+2]=pv&255;
      lightMap[index*3]=Math.round(clamp(shadow**2.2*(1+fibre*2)/2,0,1)*255);
      lightMap[index*3+1]=Math.round(sheen*255);
      lightMap[index*3+2]=Math.round(coverage*255);
    }
    shadowMap[index]=Math.round(shadow*255);
    highlightMap[index]=Math.round(sheen*255);
    for (let channel=0;channel<3;channel++) {
      const diffuse=clamp(sampled[channel]/sampled[3]*shadow**2.2*(1+fibre*2),0,1);
      const litInk=clamp((1-(1-diffuse)*(1-sheen))*tint[channel],0,1);
      output[index*4+channel]=encoded(litInk*alpha+
        linear(background[index*4+channel])*(1-alpha));
    }
  }
  return {
    image:await sharp(output,{raw:{width,height,channels:4}}).toFormat(format,format === 'webp' ? {quality:90,alphaQuality:100,smartSubsample:true} : {}).toBuffer(),
    displacement:diagnostics ? await sharp(diagnostic,{raw:{width,height,channels:3}}).png().toBuffer() : undefined,
    shadows:diagnostics ? await sharp(shadowMap,{raw:{width,height,channels:1}}).png().toBuffer() : undefined,
    highlights:diagnostics ? await sharp(highlightMap,{raw:{width,height,channels:1}}).png().toBuffer() : undefined,
    geometryMap:compile ? await sharp(geometryMap,{raw:{width,height,channels:3}}).png().toBuffer() : undefined,
    lightMap:compile ? await sharp(lightMap,{raw:{width,height,channels:3}}).png().toBuffer() : undefined,
    width,height,
  };
}
