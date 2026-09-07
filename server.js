'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {FileStore,PostgresStore}=require('./lib/storage');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv(path.join(__dirname, '.env'));
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(String(a))), Buffer.from(hash(String(b))));
const groups = ['18-22', '24-32', '34-38'];
const sizes = [18,20,22,24,26,28,30,32,34,36,38];
const statusList = ['New','Confirmed','Shipped','Delivered','Cancelled'];
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.ico':'image/x-icon' };
const text = (v, max, label, required = false) => {
  if (v !== undefined && typeof v !== 'string') throw fail(400, `Invalid ${label}.`);
  const s = (v || '').trim();
  if (s.length > max || (required && !s)) throw fail(400, `Please enter a valid ${label}.`);
  return s;
};
function prices(value) {
  const out = {};
  for (const key of groups) {
    const n = Number(value?.[key]);
    if (!Number.isFinite(n) || n < 1 || n > 100000 || Math.abs(n * 100 - Math.round(n * 100)) > 0.00001) throw fail(400, 'All prices must be between ₹1 and ₹100,000, with at most two decimal places.');
    out[key] = n;
  }
  return out;
}
function coloursOf(p) {
  if (Array.isArray(p.colours)) return p.colours.filter(c => c.active !== false && c.image);
  return [1,2,3,4].map(n => ({name:'Colour '+n, image:p.image, active:true}));
}
function quote(catalogue, input) {
  if (!Array.isArray(input) || !input.length || input.length > 50) throw fail(400, 'Please choose between 1 and 50 items.');
  const grouped = new Map();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw fail(400, 'Invalid cart item.');
    const p = catalogue.products.find(p => p.id === raw.productId);
    if (!p || p.available === false) throw fail(409, 'A design in your cart is no longer available. Please update your cart.');
    const size = Number(raw.size), qty = Number(raw.qty);
    if (!sizes.includes(size) || !Number.isInteger(qty) || qty < 1 || qty > 20) throw fail(400, 'Choose a valid size and quantity between 1 and 20.');
    const c = coloursOf(p).find(c => c.name === raw.colour);
    if (!c) throw fail(409, `${p.name}: this colour is no longer available. Please update your cart.`);
    const group = size <= 22 ? groups[0] : size <= 32 ? groups[1] : groups[2];
    const price = prices(p.customPricing?.enabled ? p.customPricing.prices : catalogue.settings.pricing)[group];
    const key = p.id+'|'+c.name+'|'+size;
    if (grouped.has(key)) { grouped.get(key).qty += qty; if (grouped.get(key).qty > 20) throw fail(400,'Maximum 20 pieces per colour and size.'); }
    else grouped.set(key, {key,productId:p.id,name:p.name,colour:c.name,size:String(size),qty,price,image:c.image});
  }
  const items = [...grouped.values()];
  const amount = items.reduce((sum,x) => sum + Math.round(x.price*100)*x.qty,0);
  if (amount > 100000000) throw fail(400, 'Please contact AYKIRA for large wholesale orders.');
  return {items,amount,currency:'INR'};
}
function customer(raw) {
  if (!raw || typeof raw !== 'object') throw fail(400,'Delivery details are required.');
  const c = Object.fromEntries([['name',100],['phone',10],['address',500],['pincode',6],['city',100],['state',100],['email',254]].map(([k,max]) => [k,text(raw[k],max,k,k!=='email')]));
  if (!/^[6-9]\d{9}$/.test(c.phone) || !/^[1-9]\d{5}$/.test(c.pincode) || (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))) throw fail(400,'Please enter valid contact and PIN details.');
  return c;
}
function createApp(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.dataDir || env.AYKIRA_DATA_DIR || path.join(__dirname,'data'));
  const publicDir = options.publicDir || path.join(__dirname,'public');
  const db=options.store || ((env.VERCEL || env.DATABASE_URL) ? new PostgresStore(env) : new FileStore(root));
  const catalog=()=>db.catalog(), readOrder=id=>db.readOrder(id), findOrder=id=>db.findOrder(id), allOrders=()=>db.listOrders();
  const adminPass=env.AYKIRA_ADMIN_PASSWORD||'';
  const preview=env.VERCEL_ENV==='preview';
  const configured=!!env.RAZORPAY_KEY_ID&&!!env.RAZORPAY_KEY_SECRET&&(!preview||env.RAZORPAY_KEY_ID.startsWith('rzp_test_'));
  const secure=env.VERCEL==='1'||env.NODE_ENV==='production';
  async function rate(req,kind,max){
    const ip=env.VERCEL==='1'?String(req.headers['x-vercel-forwarded-for']||req.socket.remoteAddress):req.socket.remoteAddress;
    if(!await db.rate(hash(kind+':'+ip),max))throw fail(429,'Too many requests. Please try again in a minute.');
  }
  async function gateway(method, endpoint, payload) {
    if (!configured) throw fail(503,'Online payments are not enabled yet. Please try again later.');
    if (options.gateway) return options.gateway(method,endpoint,payload);
    let response;
    try {response=await fetch('https://api.razorpay.com/v1'+endpoint,{method,headers:{Authorization:'Basic '+Buffer.from(env.RAZORPAY_KEY_ID+':'+env.RAZORPAY_KEY_SECRET).toString('base64'),'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(15000)});}catch(_){throw fail(502,'Payment service is temporarily unavailable.');}
    const d=await response.json().catch(()=>({}));
    if(!response.ok)throw fail(502,'Payment service could not complete this request.');
    return d;
  }
  async function body(req,max=128*1024,raw=false) {
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail(415,'Send JSON content.');
    if(Number(req.headers['content-length']||0)>max)throw fail(413,'Request is too large.');
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>max)throw fail(413,'Request is too large.');chunks.push(chunk);}
    const buffer=Buffer.concat(chunks);
    if(raw)return buffer;
    try{const v=JSON.parse(buffer.toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch(_){throw fail(400,'Invalid JSON.');}
  }
  async function auth(req) {
    const token=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('aykira_admin='))?.slice(13);
    const session=token?await db.session(hash(token+adminPass)):null;
    if(!session || session.expires<Date.now())throw fail(401,'Please sign in to the admin panel.');
    if(req.method!=='GET' && !equal(req.headers['x-csrf-token']||'',session.csrf))throw fail(403,'Your session needs refreshing. Please sign in again.');
    return {token,...session};
  }
  function normalizeImage(value,uploads) {
    if(typeof value!=='string')throw fail(400,'An image is required.');
    if(/^https:\/\/[a-zA-Z0-9-]+\.public\.blob\.vercel-storage\.com\/aykira_v23(?:_preview)?\/products\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(value))return value;
    if(/^\/(images|uploads)\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(value))return value;
    if(/^\/design-0[1-8]\.png$/.test(value))return value;
    const m=value.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if(!m)throw fail(400,'Use JPG, PNG, WebP or GIF images.');
    const bytes=Buffer.from(m[2],'base64');
    if(!bytes.length || bytes.length>2*1024*1024)throw fail(400,'Images must be under 2 MB.');
    const valid=m[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ['jpg','jpeg'].includes(m[1]) ? bytes[0]===255&&bytes[1]===216&&bytes[2]===255 : m[1]==='webp' ? bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP' : /^GIF8[79]a$/.test(bytes.toString('ascii',0,6));
    if(!valid)throw fail(400,'This image file is not valid.');
    const name=hash(bytes)+'.'+(m[1]==='jpeg'?'jpg':m[1]);uploads.set(name,bytes);return '/uploads/'+name;
  }
  function normalizeCatalog(b) {
    if(!Array.isArray(b.products)||b.products.length>200||!b.settings)throw fail(400,'Invalid catalogue.');
    const uploads=new Map(),ids=new Set();
    const settings={pricing:prices(b.settings.pricing)};
    for(const k of ['eyebrow','title','lead','collection','festive','size'])settings[k]=text(b.settings[k],1000,k);
    const products=b.products.map(p=>{
      if(!p||typeof p!=='object')throw fail(400,'Invalid design.');
      const id=text(p.id,100,'design ID',true);
      if(!/^[a-zA-Z0-9_-]+$/.test(id)||ids.has(id))throw fail(400,'Design IDs must be unique.');ids.add(id);
      const out={id,name:text(p.name,150,'design name',true),description:text(p.description,1000,'description'),image:normalizeImage(p.image,uploads),available:p.available!==false,customPricing:{enabled:!!p.customPricing?.enabled}};
      if(out.customPricing.enabled)out.customPricing.prices=prices(p.customPricing.prices);
      if(p.colours!==undefined){if(!Array.isArray(p.colours)||p.colours.length>4)throw fail(400,'Use up to four colours.');const names=new Set();out.colours=p.colours.map(c=>{const name=text(c.name,80,'colour name',true);if(names.has(name))throw fail(400,'Colour names must be unique per design.');names.add(name);return {name,active:c.active!==false,image:c.image?normalizeImage(c.image,uploads):out.image};});}
      return out;
    });
    return {data:{products,settings},uploads};
  }
  async function markPaid(order,payment) {
    if(!payment||payment.order_id!==order.razorpay_order_id||payment.amount!==order.amount||payment.currency!=='INR'||payment.status!=='captured')throw fail(409,'Payment is not captured or does not match this order.');
    return db.markPaid(order.aykira_order_id,payment);
  }
  async function reconcile(order) {
    if(order.payment_status==='paid'||!order.razorpay_order_id)return order;
    const result=await gateway('GET','/orders/'+encodeURIComponent(order.razorpay_order_id)+'/payments');
    const paid=(result.items||[]).find(p=>p.status==='captured');
    return paid?markPaid(order,paid):order;
  }
  function send(req,res,status,data,headers={}) {
    const out=Buffer.from(JSON.stringify(data));
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(out);
  }
  const app=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,'http://localhost'),route=url.pathname;
      if(!['GET','HEAD','POST'].includes(req.method))throw fail(405,'Method not allowed.');
      if(req.method==='POST' && route!=='/api/razorpay/webhook'){
        const origin=req.headers.origin;const allowed=env.APP_ORIGIN || (secure?'https://':'http://')+req.headers.host;
        const currentOrigin=(secure?'https://':'http://')+req.headers.host;
        if((origin && origin!==allowed && origin!==currentOrigin) || req.headers['sec-fetch-site']==='cross-site')throw fail(403,'Cross-site request rejected.');
      }
      if(route.startsWith('/api/')){
        if(!['/api/health','/api/config','/api/version','/api/catalog'].includes(route))await rate(req,'api',180);
        if(req.method==='GET' && route==='/api/health'){await db.ready();return send(req,res,200,{ok:true,version:'23.0.0',storage:env.VERCEL||env.DATABASE_URL?'postgres':'local',admin_configured:adminPass.length>=16,payments_configured:configured,webhook_configured:!!env.RAZORPAY_WEBHOOK_SECRET});}
        if(req.method==='GET' && route==='/api/version')return send(req,res,200,{version:'V23'});
        if(req.method==='GET' && route==='/api/config')return send(req,res,200,{key_id:configured?env.RAZORPAY_KEY_ID:null,payments_enabled:configured&&adminPass.length>=16&&(!env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')||!!env.RAZORPAY_WEBHOOK_SECRET),mode:env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')?'live':'test'});
        if(req.method==='GET' && route==='/api/catalog'){const c=await catalog();return send(req,res,200,c);}
        if(req.method==='POST' && route==='/api/admin/login'){
          await rate(req,'login',10);const b=await body(req,2048);
          if(adminPass.length<16)throw fail(503,'Admin setup is incomplete. Run the setup launcher.');
          if(typeof b.password!=='string'||!equal(b.password,adminPass))throw fail(401,'Wrong password.');
          const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(32).toString('hex');await db.createSession(hash(token+adminPass),csrf,Date.now()+8*3600000);
          return send(req,res,200,{success:true,csrf},{'Set-Cookie':`aykira_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=28800${secure?'; Secure':''}`});
        }
        if(route.startsWith('/api/admin/')){
          const session=await auth(req);
          if(req.method==='GET' && route==='/api/admin/session')return send(req,res,200,{success:true,csrf:session.csrf});
          if(req.method==='POST' && route==='/api/admin/logout'){await db.deleteSession(hash(session.token+adminPass));return send(req,res,200,{success:true},{'Set-Cookie':'aykira_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0'});}
          if(req.method==='GET' && route==='/api/admin/orders')return send(req,res,200,{orders:(await allOrders()).map(({tracking_hash,request_hash,...o})=>o)});
          if(req.method==='POST' && route==='/api/admin/save'){
            const b=await body(req,512*1024),normalized=normalizeCatalog(b);
            if(normalized.uploads.size)throw fail(400,'Please upload photos separately before saving.');
            const fresh=await db.saveCatalog(normalized.data,b.revision);return send(req,res,200,{success:true,...fresh});
          }
          if(req.method==='POST' && route==='/api/admin/upload'){
            const b=await body(req,3*1024*1024),uploads=new Map();const url=normalizeImage(b.image,uploads);
            let result=url;for(const [name,bytes] of uploads)result=await db.image(name,bytes);
            return send(req,res,200,{success:true,url:result});
          }
          if(req.method==='POST' && route==='/api/admin/order-status'){
            const b=await body(req),o=await readOrder(b.order_id);
            if(!statusList.includes(b.status))throw fail(400,'Invalid order status.');
            if(o.payment_status!=='paid'&&b.status!=='Cancelled')throw fail(409,'Payment has not been confirmed.');
            await db.setStatus(o.aykira_order_id,b.status);return send(req,res,200,{success:true});
          }
          if(req.method==='POST' && route==='/api/admin/reconcile'){
            const b=await body(req),o=await reconcile(await readOrder(b.order_id));return send(req,res,200,{success:true,payment_status:o.payment_status});
          }
          if(req.method==='POST' && route==='/api/admin/password')throw fail(403,'Change AYKIRA_ADMIN_PASSWORD in the server settings and restart.');
          throw fail(404,'Endpoint not found.');
        }
        if(req.method==='GET' && route.startsWith('/api/pincode/')){
          await rate(req,'pin',30);const pin=route.split('/').pop();if(!/^[1-9]\d{5}$/.test(pin))throw fail(400,'Invalid PIN code.');
          let d;try{const r=await fetch('https://api.postalpincode.in/pincode/'+pin,{signal:AbortSignal.timeout(6000)});if(!r.ok)throw Error();d=await r.json();}catch(_){throw fail(502,'PIN lookup unavailable. Please enter city and state manually.');}
          const p=d?.[0]?.PostOffice?.[0];if(!p)throw fail(404,'PIN code not found.');return send(req,res,200,{city:p.District||p.Block||'',state:p.State||'',area:p.Name||''});
        }
        if(req.method==='POST' && route==='/api/quote'){const b=await body(req);return send(req,res,200,quote(await catalog(),b.items));}
        if(req.method==='POST' && route==='/api/create-order'){
          await rate(req,'create',15);const b=await body(req),q=quote(await catalog(),b.items),c=customer(b.customer);
          if(!configured || adminPass.length<16 || (env.RAZORPAY_KEY_ID.startsWith('rzp_live_')&&!env.RAZORPAY_WEBHOOK_SECRET))throw fail(503,'Online payments are not enabled yet.');
          if(b.amount!==q.amount || b.currency!=='INR')throw fail(409,'Prices changed. Please review the updated total.',{quote:q});
          if(!/^[a-f0-9]{64}$/.test(b.checkout_token||''))throw fail(400,'Please reopen checkout.');
          const requestHash=hash(JSON.stringify({items:q.items,customer:c})),tokenHash=hash(b.checkout_token);
          const id='AYK-'+tokenHash.slice(0,32);
          const intent={aykira_order_id:id,tracking_hash:tokenHash,request_hash:requestHash,...q,customer:c,status:'Payment Pending',payment_status:'pending',created_at:new Date().toISOString()};
          let o;
          if(await db.claimOrder(intent)){
            const r=await gateway('POST','/orders',{amount:q.amount,currency:'INR',receipt:id});
            if(!r.id||r.amount!==q.amount||r.currency!=='INR')throw fail(502,'Payment order could not be confirmed.');
            o=await db.attachPaymentOrder(id,r.id);
          }else{
            o=await readOrder(id);
            if(o.request_hash!==requestHash)throw fail(409,'Checkout changed. Close and reopen checkout.');
            if(!o.razorpay_order_id)throw fail(409,'This order is still being prepared. Wait a moment, then try again. If it remains pending, reopen checkout.');
          }
          return send(req,res,200,{order_id:o.razorpay_order_id,amount:o.amount,currency:'INR',aykira_order_id:id,payment_status:o.payment_status});
        }
        if(req.method==='POST' && route==='/api/verify-payment'){
          const b=await body(req),o=await findOrder(b.razorpay_order_id);if(!o)throw fail(404,'Order not found.');
          const expected=crypto.createHmac('sha256',env.RAZORPAY_KEY_SECRET||'').update(o.razorpay_order_id+'|'+b.razorpay_payment_id).digest('hex');
          if(!/^[a-f0-9]{64}$/.test(b.razorpay_signature||'')||!equal(expected,b.razorpay_signature))throw fail(400,'Payment signature mismatch.');
          const p=await gateway('GET','/payments/'+encodeURIComponent(b.razorpay_payment_id));
          const paid=await markPaid(o,p);return send(req,res,200,{success:true,payment_id:p.id,order_id:o.razorpay_order_id,aykira_order_id:paid.aykira_order_id});
        }
        if(req.method==='POST' && route==='/api/order-status'){
          const b=await body(req),o=await readOrder(b.order_id);if(!b.checkout_token||!equal(hash(b.checkout_token),o.tracking_hash))throw fail(404,'Order not found.');
          const fresh=await reconcile(o);return send(req,res,200,{aykira_order_id:o.aykira_order_id,payment_status:fresh.payment_status,status:fresh.status});
        }
        if(req.method==='POST' && route==='/api/razorpay/webhook'){
          if(!env.RAZORPAY_WEBHOOK_SECRET)throw fail(503,'Webhook is not configured.');
          const raw=await body(req,1024*1024,true),signature=req.headers['x-razorpay-signature'];
          const expected=crypto.createHmac('sha256',env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
          if(!/^[a-f0-9]{64}$/.test(signature||'')||!equal(expected,signature))throw fail(400,'Invalid webhook signature.');
          let event;try{event=JSON.parse(raw);}catch(_){throw fail(400,'Invalid JSON.');}
          if(['payment.captured','order.paid'].includes(event.event)){
            const p=event.payload?.payment?.entity,o=p&&await findOrder(p.order_id);
            if(o)await markPaid(o,p);else throw fail(503,'Order is not available yet. Retry this event.');
          }
          return send(req,res,200,{success:true});
        }
        throw fail(404,'Endpoint not found.');
      }
      if(!['GET','HEAD'].includes(req.method))throw fail(405,'Method not allowed.');
      let pathname;try{pathname=decodeURIComponent(route);}catch(_){throw fail(400,'Invalid URL.');}
      if(pathname==='/')pathname='/index.html';
      const allowed=['/index.html','/admin.html','/admin.js','/store.js','/styles.css','/favicon.ico'].includes(pathname)||/^\/images\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(pathname)||/^\/design-0[1-8]\.png$/.test(pathname);
      const upload=/^\/uploads\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(pathname);
      if(!allowed&&!upload)throw fail(404,'Not found.');
      const file=upload?path.join(root,pathname):path.join(publicDir,pathname);
      if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw fail(404,'Not found.');
      const ext=path.extname(file),headers={'Content-Type':mime[ext]||'application/octet-stream','Cache-Control':['.html','.js','.css'].includes(ext)?'no-cache':'public, max-age=31536000, immutable'};
      const zip=/\bgzip\b/.test(req.headers['accept-encoding']||'')&&['.html','.js','.css'].includes(ext);
      if(zip){headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';}
      res.writeHead(200,headers);if(req.method==='HEAD')return res.end();
      const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());if(zip)stream.pipe(zlib.createGzip()).pipe(res);else stream.pipe(res);
    }catch(err){if(res.headersSent)return res.destroy();if(!err.status)console.error('AYKIRA request failed:',err.code||err.name);send(req,res,err.status||500,{error:err.status?err.message:'The store is temporarily unavailable. Please try again.',...err.extra});}
  });
  app.requestTimeout=30000;app.headersTimeout=15000;
  return app;
}
if(require.main===module){const app=createApp();app.on('error',err=>{console.error(err.code==='EADDRINUSE'?'Port is already in use. Stop the previous AYKIRA server or change PORT.':err.message);process.exitCode=1;app.close();});app.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log('AYKIRA running on port '+(process.env.PORT||3000)));}
let hosted;
module.exports=async(req,res)=>{if(!hosted)hosted=createApp().listeners('request')[0];return hosted(req,res)};
Object.assign(module.exports,{createApp,quote,coloursOf});
