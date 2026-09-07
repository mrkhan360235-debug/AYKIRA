'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createApp,quote,coloursOf}=require('../server');

test('store security and payment lifecycle',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aykira-test-'));
 const env={AYKIRA_ADMIN_PASSWORD:'unique-test-password-12345',RAZORPAY_KEY_ID:'rzp_test_mock',RAZORPAY_KEY_SECRET:'mock-secret',RAZORPAY_WEBHOOK_SECRET:'mock-webhook-secret'};
 const payments=new Map();let createCount=0,createdPayload;
 const gateway=async(method,route,payload)=>{
  if(method==='POST'&&route==='/orders'){createCount++;createdPayload=payload;return {id:'order_mock_'+createCount,...payload};}
  if(route.startsWith('/payments/'))return payments.get(route.split('/').pop());
  if(route.endsWith('/payments'))return {items:[...payments.values()].filter(p=>p.order_id===route.split('/')[2])};
  throw Error('Unexpected gateway request: '+route);
 };
 const app=createApp({dataDir:dir,env,gateway});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>app.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.address().port;
 async function request(route,b,headers={}){const r=await fetch(base+route,{method:b===undefined?'GET':'POST',headers:{...(b===undefined?{}:{'Content-Type':'application/json'}),...headers},body:b===undefined?undefined:JSON.stringify(b)});return {status:r.status,body:await r.json(),headers:r.headers};}
 let cookie,csrf,catalog,order;
 const buyer={name:'Test Buyer',phone:'9876543210',address:'Test address',pincode:'110001',city:'New Delhi',state:'Delhi',email:''};
 const items=[{productId:'design-01',colour:'Colour 1',size:'18',qty:2,price:1,name:'Forged title'}];
 const checkoutToken='a'.repeat(64);
 await t.test('private files and old embedded folder are not served',async()=>{for(const route of ['/.env','/server.js','/aykira-orders.json','/data/catalog.json','/seed/catalog.json','/AYKIRA_RAZORPAY_FINAL_V18/.env','/%2eenv','/uploads/../.env'])assert.equal((await request(route)).status,404,route);});
 await t.test('orders and catalogue writes require authentication',async()=>{assert.equal((await request('/api/admin/orders')).status,401);assert.equal((await request('/api/admin/save',{})).status,401);});
 await t.test('login sets HttpOnly cookie; CSRF and same-origin checks protect mutations',async()=>{
  assert.equal((await request('/api/admin/login',{password:'wrong'})).status,401);
  const r=await request('/api/admin/login',{password:env.AYKIRA_ADMIN_PASSWORD});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.body.csrf;
  assert.equal((await request('/api/admin/save',{}, {Cookie:cookie})).status,403);
  assert.equal((await request('/api/admin/save',{}, {Cookie:cookie,'X-CSRF-Token':csrf,Origin:'https://unrelated.example'})).status,403);
 });
 await t.test('quote ignores client prices and rejects unavailable variants and invalid quantities',async()=>{
  catalog=(await request('/api/catalog')).body;
  const q=await request('/api/quote',{items});assert.equal(q.status,200);assert.equal(q.body.amount,159800);assert.equal(q.body.items[0].name,'Olive Festive Set');
  for(const patch of [{qty:0},{qty:-1},{qty:1.5},{qty:21},{size:'19'},{productId:'fake'},{colour:'fake'}])assert.ok((await request('/api/quote',{items:[{...items[0],...patch}]})).status>=400);
  assert.equal(coloursOf({...catalog.products[0],colours:[{name:'Colour 1',image:'x',active:false}]}).length,0);
  assert.throws(()=>quote({...catalog,products:catalog.products.map(p=>({...p,available:false}))},items));
 });
 await t.test('catalogue validation is atomic and stale edits cannot overwrite newer changes',async()=>{
  const headers={Cookie:cookie,'X-CSRF-Token':csrf};
  const bad=structuredClone(catalog);bad.products[0].customPricing={enabled:true,prices:{'18-22':0,'24-32':999,'34-38':1199}};
  assert.equal((await request('/api/admin/save',bad,headers)).status,400);assert.deepEqual((await request('/api/catalog')).body,catalog);
  const saved=await request('/api/admin/save',catalog,headers);assert.equal(saved.status,200);assert.equal(saved.body.revision,catalog.revision+1);
  assert.equal((await request('/api/admin/save',catalog,headers)).status,409);catalog=saved.body;
 });
 await t.test('tampered checkout amount is rejected before gateway contact',async()=>{const r=await request('/api/create-order',{amount:100,currency:'INR',items,customer:buyer,checkout_token:checkoutToken});assert.equal(r.status,409);assert.equal(createCount,0);});
 await t.test('checkout creates a canonical order and retries reuse the same payment order',async()=>{
  const b={amount:159800,currency:'INR',items,customer:buyer,checkout_token:checkoutToken};
  const first=await request('/api/create-order',b);assert.equal(first.status,200);order=first.body;
  assert.equal(createdPayload.amount,159800);assert.equal((await request('/api/create-order',b)).body.order_id,order.order_id);assert.equal(createCount,1);
  assert.equal((await request('/api/create-order',{...b,customer:{...buyer,name:'Different Buyer'}})).status,409);
 });
 await t.test('verification rejects forged signatures, unknown orders, wrong amounts and authorized-only payments',async()=>{
  const sign=id=>crypto.createHmac('sha256',env.RAZORPAY_KEY_SECRET).update(order.order_id+'|'+id).digest('hex');
  const verify=(id,sig=sign(id))=>request('/api/verify-payment',{razorpay_order_id:order.order_id,razorpay_payment_id:id,razorpay_signature:sig});
  assert.equal((await verify('pay_bad','0'.repeat(64))).status,400);
  assert.equal((await request('/api/verify-payment',{razorpay_order_id:'unknown'})).status,404);
  payments.set('pay_wrong',{id:'pay_wrong',order_id:order.order_id,amount:100,currency:'INR',status:'captured'});assert.equal((await verify('pay_wrong')).status,409);payments.delete('pay_wrong');
  payments.set('pay_ok',{id:'pay_ok',order_id:order.order_id,amount:159800,currency:'INR',status:'authorized'});assert.equal((await verify('pay_ok')).status,409);
  payments.get('pay_ok').status='captured';assert.equal((await verify('pay_ok')).status,200);
 });
 await t.test('webhook signature is checked and replay does not reset shipped status',async()=>{
  const headers={Cookie:cookie,'X-CSRF-Token':csrf};assert.equal((await request('/api/admin/order-status',{order_id:order.aykira_order_id,status:'Shipped'},headers)).status,200);
  const b={event:'payment.captured',payload:{payment:{entity:payments.get('pay_ok')}}};
  assert.equal((await request('/api/razorpay/webhook',b,{'X-Razorpay-Signature':'0'.repeat(64)})).status,400);
  const signature=crypto.createHmac('sha256',env.RAZORPAY_WEBHOOK_SECRET).update(JSON.stringify(b)).digest('hex');assert.equal((await request('/api/razorpay/webhook',b,{'X-Razorpay-Signature':signature})).status,200);
  const orders=await request('/api/admin/orders',undefined,{Cookie:cookie});assert.equal(orders.body.orders[0].status,'Shipped');assert.equal(orders.body.orders[0].tracking_hash,undefined);
 });
 await t.test('customer order status requires its unguessable token',async()=>{assert.equal((await request('/api/order-status',{order_id:order.aykira_order_id,checkout_token:'wrong'})).status,404);const r=await request('/api/order-status',{order_id:order.aykira_order_id,checkout_token:checkoutToken});assert.equal(r.body.payment_status,'paid');assert.equal(r.body.customer,undefined);});
 await t.test('signed webhook can recover a paid order without a browser callback',async()=>{
  const r=await request('/api/create-order',{amount:159800,currency:'INR',items,customer:buyer,checkout_token:'b'.repeat(64)});
  const payment={id:'pay_recovered',order_id:r.body.order_id,amount:159800,currency:'INR',status:'captured'};
  const b={event:'payment.captured',payload:{payment:{entity:payment}}};const signature=crypto.createHmac('sha256',env.RAZORPAY_WEBHOOK_SECRET).update(JSON.stringify(b)).digest('hex');
  assert.equal((await request('/api/razorpay/webhook',b,{'X-Razorpay-Signature':signature})).status,200);
  assert.equal((await request('/api/order-status',{order_id:r.body.aykira_order_id,checkout_token:'b'.repeat(64)})).body.payment_status,'paid');
 });
 await t.test('logout revokes the server session',async()=>{assert.equal((await request('/api/admin/logout',{}, {Cookie:cookie,'X-CSRF-Token':csrf})).status,200);assert.equal((await request('/api/admin/orders',undefined,{Cookie:cookie})).status,401);});
});

test('store and admin can start without payment credentials',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aykira-disabled-'));const app=createApp({dataDir:dir,env:{}});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.address().port;assert.equal((await (await fetch(base+'/api/config')).json()).payments_enabled,false);assert.equal((await fetch(base+'/')).status,200);
});

test('rejected provider calls allow retry; uncertain timeouts keep the checkout claim',async t=>{
 for(const rejected of [true,false]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aykira-retry-'));let calls=0;
  const app=createApp({dataDir:dir,env:{AYKIRA_ADMIN_PASSWORD:'test-password-123456789',RAZORPAY_KEY_ID:'rzp_test_mock',RAZORPAY_KEY_SECRET:'test-secret'},gateway:async(method,route,payload)=>{calls++;if(calls===1){const e=new Error('provider failure');e.status=502;e.definitiveRejection=rejected;throw e;}return {id:'order_retry',...payload};}});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  try{const b={amount:159800,currency:'INR',checkout_token:'b'.repeat(64),items:[{productId:'design-01',colour:'Colour 1',size:'18',qty:2}],customer:{name:'Test',phone:'9876543210',address:'Test address',pincode:'110001',city:'Delhi',state:'Delhi',email:''}};
  const send=()=>fetch('http://127.0.0.1:'+app.address().port+'/api/create-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
  assert.equal((await send()).status,502);assert.equal((await send()).status,rejected?200:409);assert.equal(calls,rejected?2:1);
  }finally{await new Promise(r=>app.close(r));fs.rmSync(dir,{recursive:true,force:true});}
 }
});
