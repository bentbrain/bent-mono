import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildAll,root,style,restoreEmail} from './build.mjs';
import {buildEmail,logoUrl} from './branding/build-template.mjs';
import {liquid,renderEmail,previewSyntax} from './render.mjs';
import {fixture,shirtId,toteId} from './fixtures.mjs';

test('all Shopify templates retain their original logic and parse after generation',async()=>{
 const manifest=await buildAll();assert.equal(manifest.length,46);
 for(const entry of manifest){const source=await readFile(root+'sources/'+entry.template+'.liquid','utf8');const generated=await readFile(root+'dist/'+entry.template+'.liquid','utf8');assert.equal(restoreEmail(generated),source,entry.template);liquid.parse(previewSyntax(generated));}
});
test('a paid black M shirt and black tote render their own configured previews',async()=>{
 const source=await readFile(root+'sources/order_confirmation.liquid','utf8');const html=await renderEmail(buildEmail(source,style,logoUrl).html);
 assert.match(html,new RegExp(shirtId+'/black.png\\?width=384'));assert.match(html,new RegExp(toteId+'/black.png\\?width=384'));
 assert.match(html,/Black \/ M/);assert.match(html,/Black \/ One size/);assert.match(html,/\$125\.00/);
 assert.match(html,/6 Sep 2026 at 9:00 pm AEST/);assert.match(html,/Manage order/);assert.doesNotMatch(html,/<img[^>]+_orderManagementCapability/);
});
test('pending payment does not gain a Manage order action',async()=>{
 const source=await readFile(root+'sources/order_confirmation.liquid','utf8');const data=fixture();data.financial_status='pending';data.has_pending_payment=true;data.transactions=[];
 const html=await renderEmail(buildEmail(source,style,logoUrl).html,data);assert.doesNotMatch(html,/>\s*Manage order\s*</);
});
test('ordinary items and unsupported colours keep their catalogue image',async()=>{
 const source=await readFile(root+'sources/order_confirmation.liquid','utf8');const data=fixture();data.subtotal_line_items[0].properties={};data.subtotal_line_items[1].variant.title='Purple / One size';
 const html=await renderEmail(buildEmail(source,style,logoUrl).html,data);assert.doesNotMatch(html,/src="https:\/\/shop.bent.build\/api\/configured-product-image/);assert.match(html,/src="https:\/\/example.invalid\/catalogue.png"/);
});

for (const template of ['shipping_confirmation', 'shipping_update']) {
 test(`${template} shows direct Australia Post tracking and both items without extra actions`, async()=>{
  const source=await readFile(root+'sources/'+template+'.liquid','utf8');
  for(const carrier of ['AUSTRALIA_POST','Australia Post']) {
   const data=fixture();
   data.fulfillment.tracking_company=carrier;
   data.fulfillment.tracking_numbers=['SAMPLE123'];
   data.fulfillment.tracking_url='https://easyordertracking.aftership.com/SAMPLE123';
   data.fulfillment.tracking_urls=[data.fulfillment.tracking_url];
   data.shop_app_tracking_url='https://shop.app/track/example';
   data.shop_app_tracking_button_variant_key='track_with_shop';
   const html=await renderEmail(buildEmail(source,style,logoUrl).html,data);
   assert.match(html,/Australia Post tracking number/);
   assert.match(html,/href="https:\/\/auspost.com.au\/track\/SAMPLE123"/);
   assert.doesNotMatch(html,/AUSTRALIA_POST|aftership|View your order|Download to track|Track order with|Visit our store|shop\.app/);
   assert.match(html,/Black \/ M/);assert.match(html,/Black \/ One size/);
  }
 });
 test(`${template} retains other carriers and missing tracking without broken links`, async()=>{
  const source=await readFile(root+'sources/'+template+'.liquid','utf8');
  const data=fixture();
  const html=await renderEmail(buildEmail(source,style,logoUrl).html,data);
  assert.match(html,/Example carrier tracking number/);
  assert.match(html,/href="https:\/\/example.invalid\/tracking"/);
  data.fulfillment.tracking_numbers=[];
  const withoutTracking=await renderEmail(buildEmail(source,style,logoUrl).html,data);
  assert.doesNotMatch(withoutTracking,/tracking number/);
 });
}
