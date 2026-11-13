// Synthetic transport for the third-party Standard Actions script. Hydrogen
// supplies the handler, and every cart mutation reaches the real BFF and API.
export const standardActionsFixture = `
(function(){
 let configuration;
 const updateCart=async function(payload,options){
   if(!configuration) throw new Error('The cart handler is not configured.');
   const promise=configuration.handler(()=>{throw new Error('External cart writes are disabled.');},payload,options).then(result=>{
     if(result.userErrors?.length){const error=new Error(result.userErrors[0].message);error.cause=result;throw error;}return result;
   });
   if(payload.lines){
     const action=payload.lines.every(line=>!line.id)?'add':payload.lines.every(line=>line.quantity===0)?'remove':'update';
     const event=new Event('shopify:cart:lines-update');Object.assign(event,{action,lines:payload.lines,promise:promise.then(result=>({...result,cart:result.cart?{...result.cart,lines:result.cart.lines.nodes}:null})),context:options?.event?.context??'cart',detail:options?.event?.detail});
     configuration.eventTarget({type:'shopify:cart:lines-update',action})?.dispatchEvent(event);
   }
   const result=await promise;
   if(result.userErrors?.length) {const error=new Error(result.userErrors[0].message);error.cause=result;throw error;}

   return result;
 };
 updateCart.configure=function(value){configuration=value;return true;};
 updateCart.isDefault=function(){return !configuration;};
 let openHandler;
 const openCart=async function(options){return openHandler?.(()=>{},options);};
 openCart.configure=function(value){openHandler=value.handler;return true;};
 openCart.isDefault=function(){return !openHandler;};
 window.Shopify=window.Shopify||{};
 window.Shopify.actions={updateCart,openCart,getCart:async()=>{const response=await fetch('/api/cart');return response.json();}};
})();`;
