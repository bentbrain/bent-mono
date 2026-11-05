import { loadProductPreview, placedArtwork } from './product-preview';
import templates from '@/lib/lifestyle-templates.json';

const vertex=`attribute vec2 position; varying vec2 point;
void main(){point=vec2((position.x+1.0)*0.5,(1.0-position.y)*0.5);gl_Position=vec4(position,0.0,1.0);}`;
const fragment=`precision highp float;
varying vec2 point;
uniform sampler2D photo; uniform sampler2D geometry; uniform sampler2D light; uniform sampler2D artwork;
uniform vec2 inkSize; uniform vec3 tint;
vec4 ink(vec2 uv){
  if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0)return vec4(0.0);
  vec4 s=texture2D(artwork,uv);return vec4(pow(s.rgb,vec3(2.2))*s.a,s.a);
}
void main(){
  vec4 bg=texture2D(photo,point);vec3 lighting=texture2D(light,point).rgb;
  if(lighting.b==0.0){gl_FragColor=bg;return;}
  vec3 mapBytes=floor(texture2D(geometry,point).rgb*255.0+0.5);
  vec2 uv=vec2(mapBytes.r*16.0+floor(mapBytes.g/16.0),mod(mapBytes.g,16.0)*256.0+mapBytes.b)/4095.0;
  vec2 p=uv*inkSize-0.5, q=(floor(p)+0.5)/inkSize, f=fract(p), stepSize=1.0/inkSize;
  vec4 sampled=mix(mix(ink(q),ink(q+vec2(stepSize.x,0.0)),f.x),
    mix(ink(q+vec2(0.0,stepSize.y)),ink(q+stepSize),f.x),f.y);
  float alpha=sampled.a*lighting.b;
  vec3 diffuse=clamp(sampled.rgb/max(sampled.a,0.000001)*lighting.r*2.0,0.0,1.0);
  vec3 lit=clamp((1.0-(1.0-diffuse)*(1.0-lighting.g))*pow(tint,vec3(2.2)),0.0,1.0);
  gl_FragColor=vec4(pow(lit*alpha+pow(bg.rgb,vec3(2.2))*(1.0-alpha),vec3(1.0/2.2)),bg.a);
}`;
function compile(gl: WebGLRenderingContext, type:number, source:string) {
  const shader=gl.createShader(type);
  if(!shader) throw new Error('Shader unavailable.');
  gl.shaderSource(shader,source);gl.compileShader(shader);
  if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {gl.deleteShader(shader);throw new Error('Shader compilation failed.');}
  return shader;
}
async function loadImage(url:string) {
  const image=new Image();image.src=url;await image.decode();return image;
}
// Per-colour shared static assets; no artwork or user identifier in this cache.
const photos=new Map<string,Promise<HTMLImageElement[]>>();
function templateImages(color:string) {
  const template=color.toLowerCase()==='white' ? templates.white : templates.black;
  let assets=photos.get(template.prefix);
  if(!assets){
    assets=Promise.all(['base.webp','geometry.png','light.png'].map(suffix=>loadImage(`/mockups/lifestyle-v4/${template.prefix}-${suffix}`)));
    photos.set(template.prefix,assets);
    void assets.catch(()=>{photos.delete(template.prefix);});
  }
  return {template,assets};
}
export async function renderLifestylePreview(canvas:HTMLCanvasElement,productId:string,revision:string,color:string) {
  const {template,assets}=templateImages(color);
  const [source,images]=await Promise.all([loadProductPreview(productId,revision),assets]);
  if(source.recipe.baseProductSlug!=='staple-tee') throw new Error('Lifestyle unavailable.');
  const ink=placedArtwork(source,template.inkWidth);
  canvas.width=template.width;canvas.height=template.height;
  const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:false,preserveDrawingBuffer:true,antialias:false});
  if(!gl) throw new Error('WebGL unavailable.');
  const program=gl.createProgram();
  const shaders=[compile(gl,gl.VERTEX_SHADER,vertex),compile(gl,gl.FRAGMENT_SHADER,fragment)];
  const textures:WebGLTexture[]=[];
  const buffer=gl.createBuffer();
  try {
    for(const shader of shaders)gl.attachShader(program,shader);
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Shader link failed.');
    gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    const names=['photo','geometry','light','artwork'];
    [...images,ink].forEach((image,index)=>{
      const texture=gl.createTexture();
      textures.push(texture);gl.activeTexture(gl.TEXTURE0+index);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
      gl.uniform1i(gl.getUniformLocation(program,names[index] ?? ''),index);
    });
    gl.uniform2f(gl.getUniformLocation(program,'inkSize'),ink.width,ink.height);
    gl.uniform3fv(gl.getUniformLocation(program,'tint'),template.lightTint);
    gl.viewport(0,0,canvas.width,canvas.height);gl.drawArrays(gl.TRIANGLES,0,6);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('WebGL rendering failed.');
  } finally {
    for(const texture of textures)gl.deleteTexture(texture);
    for(const shader of shaders)gl.deleteShader(shader);
    gl.deleteBuffer(buffer);gl.deleteProgram(program);
  }
}
