import {Liquid} from 'liquidjs';
import {fixture} from './fixtures.mjs';
export const liquid=new Liquid({strictFilters:true,timezoneOffset:'Australia/Brisbane'});
const escape = value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
liquid.registerFilter('money',v=>new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(Number(v??0)/100));
liquid.registerFilter('money_with_currency',v=>new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(Number(v??0)/100)+' AUD');
liquid.registerFilter('img_url',v=>v?.image??'');
liquid.registerFilter('format_address',v=>[v?.name,v?.address1,v?.city,v?.province,v?.zip,v?.country].filter(Boolean).map(escape).join('<br>'));
for(const filter of ['shopify_asset_url','cdn_asset_url','payment_type_img_url','payment_icon_png_url'])liquid.registerFilter(filter,v=>'https://example.invalid/assets/'+encodeURIComponent(v??''));
liquid.registerFilter('unit_price_with_measurement',v=>String(v??''));
liquid.registerFilter('format_code',v=>String(v??''));
liquid.registerFilter('attach_as_pdf',()=> '');
liquid.registerFilter('t',v=>String(v??''));
// Layout approximation for local iteration. Shopify's server applies its own base stylesheet and CSS inlining.
const base=`body{margin:0;background:white}table{border-spacing:0;border-collapse:collapse}td{vertical-align:top}.body,.row{width:100%}.container{width:560px;text-align:left;margin:0 auto}h1,h2,h3,h4{margin-top:0}.order-list__item-price,.subtotal-line__value,.order-number__cell{text-align:right}.order-list__product-image{margin-right:16px}.order-list__item-title{font-weight:bold}.order-list__item-variant{font-size:14px}.order-list__item__cell{border-bottom:1px solid #eee}.button{width:100%}.button__text{display:block;padding:20px;text-align:center;text-decoration:none}.actions-buttons{width:100%}.actions-buttons__cell{width:49%}.button__cell--separator{width:16px}.secondary-action-cell{text-align:center;padding:20px 0}.footer__cell{padding:28px 0}.customer-info__item{width:50%;padding:0 20px 20px 0}.subtotal-lines{width:100%;margin-top:24px}.subtotal-line td{padding:6px 0}.subtotal-spacer{width:35%}.subtotal-table{width:100%}.subtotal-table--total{border-top:1px solid #0647ff}.order-list__item-price p{white-space:nowrap}.order-list__item__cell>table{width:100%}.order-list__price-cell{text-align:right;white-space:nowrap;padding-left:16px}.order-list__image-cell{width:76px}.order-list__product-description-cell{width:100%}.section__cell{border-top:1px solid #0647ff}@media(max-width:600px){.container{width:90%}.customer-info__item{display:block;width:100%}.actions-buttons__cell{display:block;width:100%;padding-bottom:16px}.button__cell--separator{display:block;height:16px}.subtotal-spacer{display:none}}`;
export function previewSyntax(source) {
 return source.replace("{{ [location.address1, location.address2].compact.join(', ') }}", "{{ location.address1 }}{% if location.address2 != blank %}, {{ location.address2 }}{% endif %}");
}
export async function renderEmail(source,data=fixture()){
 return (await liquid.parseAndRender(previewSyntax(source),data)).replace(/<link[^>]+href="\/assets\/notifications\/styles.css"[^>]*>/,`<style>${base}</style>`);
}
