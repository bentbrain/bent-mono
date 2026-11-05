import {expect,test} from 'bun:test';
import {constrainView,HOME_VIEW,transformGesture,zoomView} from './navigation';
const size={width:400,height:300};
test('Pinch preserves its focal point while zooming and panning',()=>{
 const result=transformGesture(HOME_VIEW,[{x:0,y:0},{x:100,y:0}],[{x:-40,y:30},{x:160,y:30}],size);
 expect(result).toEqual({scale:2,x:-40,y:30});
 // The scene point at the old midpoint (50,0) follows the fingers to (60,30).
 expect(result.x+50*result.scale).toBe(60);expect(result.y).toBe(30);
});
test('One-finger panning after a pinch starts at its current transform',()=>{
 const view={scale:2,x:-40,y:30};
 expect(transformGesture(view,[{x:160,y:30}],[{x:180,y:50}],size)).toEqual({scale:2,x:-20,y:50});
});
test('Zoom is limited, cannot lose the apartment, and returning to 1x recentres',()=>{
 expect(zoomView({x:100,y:50,scale:2},.1,{x:80,y:20},size)).toEqual(HOME_VIEW);
 expect(constrainView({x:99999,y:-99999,scale:20},size)).toEqual({scale:4,x:600,y:-450});
 expect(constrainView({x:600,y:-450,scale:4},{width:200,height:100})).toEqual({scale:4,x:300,y:-150});
});
test('Coincident fingers never create invalid transforms',()=>{
 expect(transformGesture(HOME_VIEW,[{x:0,y:0},{x:0,y:0}],[{x:0,y:0},{x:0,y:0}],size)).toEqual(HOME_VIEW);
});
