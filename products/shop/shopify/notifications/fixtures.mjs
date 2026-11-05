// Public featured-design configuration IDs; no customer's order or portrait is stored here.
export const shirtId='0733bd48-60e8-420c-b92b-2aa33b90b02e';
export const toteId='87011870-a2b3-45c8-92ae-d238fc186745';
const line=(id,title,variant,price)=>({title,product:{title},variant:{title:variant},variant_title:variant,quantity:1,current_quantity:1,price,final_price:price,original_price:price,final_line_price:price,original_line_price:price,line_price:price,properties:{_productId:id},image:'https://example.invalid/catalogue.png',line_level_discount_allocations:[],discount_allocations:[],requires_shipping:true,groups:[],components:[]});
export const lines=[line(shirtId,'bent.shirt','Black / M',6500),line(toteId,'bent.tote','Black / One size',6000)];
export function fixture(){return {
 shop:{name:'bent.shop',url:'https://shop.bent.build',email:'support@bent.build',email_accent_color:'#0647ff'},
 name:'#PREVIEW',order_name:'#PREVIEW',order_number:'PREVIEW',created_at:'2026-09-06T10:00:00Z',financial_status:'paid',currency:'AUD',requires_shipping:true,delivery_method:'shipping',has_pending_payment:false,
 subtotal_line_items:structuredClone(lines),line_items:structuredClone(lines),line_items_including_zero_quantity:structuredClone(lines),item_count:2,
 total_price:12500,subtotal_price:12500,total_outstanding:0,total_discounts:0,tax_price:0,shipping_price:0,total_paid:12500,net_payment:12500,
 transactions:[{created_at:'2026-09-06T10:00:00Z',status:'success',kind:'sale',amount:12500,gateway:'shopify_payments',gateway_display_name:'Shopify Payments',payment_details:{credit_card_company:'Visa',credit_card_last_four_digits:'4242'}}],
 attributes:{_orderManagementCapability:'x'.repeat(43)},customer:{first_name:'Sample',name:'Sample Customer'},billing_address:null,shipping_address:{name:'Sample Customer',address1:'123 Example Street',city:'Brisbane',province:'QLD',zip:'4000',country:'Australia'},
 order_status_url:'https://example.invalid/order',customer_url:'https://example.invalid/customer',fulfillment:{item_count:2,fulfillment_line_items:lines.map(line_item=>({line_item,quantity:1})),tracking_company:'Example carrier',tracking_numbers:['SAMPLE123'],tracking_urls:['https://example.invalid/tracking']},
 custom_message:'Preview message.',cancel_reason:'customer',refunds:[],refund_line_items:[],
 gift_card:{initial_value:5000,balance:5000,code:'PREVIEW-CODE',url:'https://example.invalid/gift-card'},issued_store_credit:{amount:5000},
 };}
