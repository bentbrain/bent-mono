import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { drawRecursiveArtwork } from "./renderer.mjs";
const settings = { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.25, placementY: 0.25, placementWidth: 0.4, depth: 3 };
function source(colour) {
  const canvas = createCanvas(100,100), context = canvas.getContext("2d");
  context.fillStyle=colour; context.fillRect(0,0,100,100); return canvas;
}
const pixel = (context,x,y) => [...context.getImageData(x,y,1,1).data];
test("two-source video preserves outer portrait and uses the attachment only inside recursion", () => {
  const outer=source("red"), inner=source("blue");
  const canvas=createCanvas(100,100), context=canvas.getContext("2d");
  drawRecursiveArtwork(context,outer,settings,{x:0,y:0,width:100,height:100},settings.depth,inner,{cropX:0.5,cropY:0.5,cropZoom:1});
  assert.deepEqual(pixel(context,5,5),[255,0,0,255]);
  assert.deepEqual(pixel(context,28,28),[0,0,255,255]);
  assert.deepEqual(pixel(context,40,40),[0,0,255,255]);
  assert.deepEqual(pixel(context,80,80),[255,0,0,255]);
});
test("absent second source retains the single-source renderer pixels", () => {
  const outer=source("red"), canvas=createCanvas(100,100), context=canvas.getContext("2d");
  drawRecursiveArtwork(context,outer,settings,{x:0,y:0,width:100,height:100},settings.depth);
  assert.deepEqual(pixel(context,28,28),[255,0,0,255]);
});

test("an inset portrait can place its next copy below its own collar without moving the outer inset", () => {
  const outer = source("red"), inner = source("white");
  const innerContext = inner.getContext("2d");
  innerContext.fillStyle = "blue";
  innerContext.fillRect(0, 20, 100, 10); // cap
  innerContext.fillStyle = "green";
  innerContext.fillRect(0, 40, 100, 5); // collar
  const canvas = createCanvas(100, 100), context = canvas.getContext("2d");
  drawRecursiveArtwork(context, outer,
    { ...settings, placementX: 0.25, placementY: 0.2, placementWidth: 0.5 },
    { x: 0, y: 0, width: 100, height: 100 }, 2, inner,
    { cropX: 0.5, cropY: 0.5, cropZoom: 1 },
    { placementX: 0.25, placementY: 0.5, placementWidth: 0.5 });
  assert.deepEqual(pixel(context, 30, 31), [0, 0, 255, 255], "outer inset stays in place");
  assert.deepEqual(pixel(context, 50, 36), [255, 255, 255, 255], "next cap must not appear above the collar");
  assert.deepEqual(pixel(context, 50, 41), [0, 128, 0, 255], "collar remains uncovered");
  assert.deepEqual(pixel(context, 50, 51), [0, 0, 255, 255], "next cap appears on the chest");
});
