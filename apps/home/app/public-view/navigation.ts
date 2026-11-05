export interface Point {x:number;y:number}
export interface ViewTransform extends Point {scale:number}
export interface ViewSize {width:number;height:number}
export const HOME_VIEW:ViewTransform={x:0,y:0,scale:1};
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

export function constrainView(view:ViewTransform,size:ViewSize):ViewTransform {
 const scale=clamp(view.scale,1,4);
 const maxX=size.width*(scale-1)/2,maxY=size.height*(scale-1)/2;
 return {scale,x:clamp(view.x,-maxX,maxX),y:clamp(view.y,-maxY,maxY)};
}
// Points are relative to the untransformed canvas centre. Keep the content
// beneath the original fingers attached to their new midpoint while pinching.
export function transformGesture(view:ViewTransform,from:readonly Point[],to:readonly Point[],size:ViewSize):ViewTransform {
 const a=from[0],b=to[0];if(!a||!b)return view;
 const c=from[1],d=to[1];
 const start=c?{x:(a.x+c.x)/2,y:(a.y+c.y)/2}:a;
 const end=d?{x:(b.x+d.x)/2,y:(b.y+d.y)/2}:b;
 const distance=c?Math.hypot(a.x-c.x,a.y-c.y):0;
 const ratio=c&&d&&distance>1?Math.hypot(b.x-d.x,b.y-d.y)/distance:1;
 const scale=clamp(view.scale*ratio,1,4),factor=scale/view.scale;
 return constrainView({scale,x:end.x-(start.x-view.x)*factor,y:end.y-(start.y-view.y)*factor},size);
}
export function zoomView(view:ViewTransform,scale:number,anchor:Point,size:ViewSize):ViewTransform {
 const next=clamp(scale,1,4),factor=next/view.scale;
 return constrainView({scale:next,x:anchor.x-(anchor.x-view.x)*factor,y:anchor.y-(anchor.y-view.y)*factor},size);
}
