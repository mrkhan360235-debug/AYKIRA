'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {PostgresStore}=require('../lib/storage');
const {createApp}=require('../server');
function driver(pg){return {query(q,p=[]){return {q,p,then(ok,bad){return pg.query(q,p).then(r=>r.rows).then(ok,bad);}};},transaction(queries){return pg.transaction(async tx=>{const rows=[];for(const {q,p} of queries)rows.push((await tx.query(q,p)).rows);return rows;});}};}
test('Postgres persistence, concurrency and preview isolation',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());const sql=driver(pg);
 const store=new PostgresStore({},sql),another=new PostgresStore({},sql),preview=new PostgresStore({VERCEL_ENV:'preview'},sql);
 await store.migrate();await preview.migrate();
 await t.test('current GitHub prices preserved and seeding does not overwrite edits',async()=>{
  const c=await store.catalog();assert.equal(c.settings.pricing['34-38'],1099);assert.equal(c.products[0].customPricing.prices['18-22'],799);
  c.settings.title='Persisted title';await store.saveCatalog({products:c.products,settings:c.settings},c.revision);await store.migrate();assert.equal((await another.catalog()).settings.title,'Persisted title');
  assert.notEqual((await preview.catalog()).settings.title,'Persisted title');
 });
 await t.test('concurrent catalogue saves use atomic revision checks',async()=>{
  const c=await store.catalog(),d={products:c.products,settings:c.settings};
  const results=await Promise.allSettled([store.saveCatalog(d,c.revision),another.saveCatalog(d,c.revision)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
 });
 const order={aykira_order_id:'AYK-'+ 'c'.repeat(32),amount:79900,currency:'INR',status:'Payment Pending',payment_status:'pending',items:[],customer:{name:'Test'},created_at:new Date().toISOString()};
 await t.test('only one instance can claim a checkout and both see its payment order',async()=>{
  const claims=await Promise.all([store.claimOrder(order),another.claimOrder(order)]);assert.equal(claims.filter(Boolean).length,1);
  await store.attachPaymentOrder(order.aykira_order_id,'order_pg');assert.equal((await another.findOrder('order_pg')).aykira_order_id,order.aykira_order_id);assert.equal((await preview.listOrders()).length,0);
 });
 await t.test('paid state and fulfillment survive repeat webhooks and fresh instances',async()=>{
  await assert.rejects(()=>store.setStatus(order.aykira_order_id,'Shipped'),e=>e.status===409);
  await store.markPaid(order.aykira_order_id,{id:'pay_pg'});await another.setStatus(order.aykira_order_id,'Shipped');
  await store.markPaid(order.aykira_order_id,{id:'pay_pg'});const fresh=await another.readOrder(order.aykira_order_id);assert.equal(fresh.payment_status,'paid');assert.equal(fresh.status,'Shipped');
 });
 await t.test('admin sessions and limits work across serverless instances',async()=>{
  await store.createSession('hashed-token','csrf-test',Date.now()+60000);assert.equal((await another.session('hashed-token')).csrf,'csrf-test');
  await another.deleteSession('hashed-token');assert.equal(await store.session('hashed-token'),null);
  assert.equal(await store.rate('login-test',2),true);assert.equal(await another.rate('login-test',2),true);assert.equal(await store.rate('login-test',2),false);
 });
 await t.test('database-backed HTTP handlers can run with a read-only project directory',async()=>{
  const app=createApp({env:{VERCEL:'1',VERCEL_ENV:'preview',AYKIRA_ADMIN_PASSWORD:'private-test-password-123'},dataDir:'/not-a-writable-directory',store});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  try{const base='http://127.0.0.1:'+app.address().port;const health=await (await fetch(base+'/api/health')).json();assert.equal(health.ok,true);assert.equal(health.storage,'postgres');
   const r=await fetch(base+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'private-test-password-123'})});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Secure/);
  }finally{await new Promise(r=>app.close(r));}
 });
});
