import { createCanvas } from "@napi-rs/canvas";
import { randomUUID,createHash } from "node:crypto";
import { readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderStoryVideo } from "../src/renderer.mjs";
import { ENCODING } from "../aws-lambda/config.mjs";
import { compareVideoFrames } from "./backup-fixture.mjs";
const sha = bytes=>createHash("sha256").update(bytes).digest("hex");
export function syntheticCompositionSource(source) {
  const canvas=createCanvas(source.width,source.height),ctx=canvas.getContext("2d");
  ctx.scale(source.width/600,source.height/750);
  ctx.fillStyle=source.role==="outer"?"#ff9900":"#eeeeee";ctx.fillRect(70,250,460,500);
  ctx.fillStyle=source.role==="outer"?"#ff00ff":"#0055ff";ctx.fillRect(220,50,160,200);
  ctx.fillStyle="#00aa44";ctx.fillRect(180,280,240,30);
  return canvas.toBuffer("image/png");
}
export function syntheticCompositionManifest(approved) {
  const manifest=structuredClone(approved);
  for(const key of ["commandId","designId","outerRevisionId","innerRevisionId"])manifest[key]=randomUUID();
  manifest.createdAt=Date.now();delete manifest.original;delete manifest.transfer;
  manifest.approval="Synthetic Preview fixture; no customer artwork copied.";
  manifest.products=manifest.products.map(p=>({...p,id:randomUUID()}));
  manifest.jobs=manifest.products.flatMap(p=>(p.handle==="bent-shirt"?["Black","White"]:["Black","Cream"]).map(colour=>({id:randomUUID(),productId:p.id,colour})));
  manifest.sources=manifest.sources.map(s=>{const bytes=syntheticCompositionSource(s);return {...s,size:bytes.length,sha256:sha(bytes)};});
  return manifest;
}
export async function compareCompositionVideo(directory,manifest) {
  const shirt=manifest.products.find(p=>p.handle==="bent-shirt");
  const outer=manifest.sources[0],inner=manifest.sources[1];
  const rendered=await renderStoryVideo({artwork:syntheticCompositionSource(outer),recursiveArtwork:syntheticCompositionSource(inner),
    recursiveCrop:inner.crop,recursivePlacement:inner.placement,settings:{...outer.crop,...shirt.placement,depth:shirt.depth},
    baseProductSlug:"staple-tee",mockup:await readFile(new URL("../../../apps/web/public/mockups/tee-white-cutout-v1.png",import.meta.url)),
    encoding:{...ENCODING},preset:"veryfast",websiteLabel:"shop.bent.build"});
  await writeFile(join(directory,"reference.mp4"),rendered.video);
  return compareVideoFrames(directory);
}
