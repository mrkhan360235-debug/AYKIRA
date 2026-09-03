const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
let Razorpay;
try { Razorpay = require('razorpay'); } catch (_) { Razorpay = null; }
const path = require('path');

function loadEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (_) {}
}
loadEnv(path.join(__dirname, '.env'));
const DATA_FILE = path.join(__dirname, 'aykira-data.json');
const ORDERS_FILE = '/tmp/aykira-orders.json';
const ADMIN_PASSWORD = process.env.AYKIRA_ADMIN_PASSWORD || 'AYKIRA@1234';
function defaultData(){ return { products: [], settings: {eyebrow:'ETHNIC • FESTIVE • OCCASION WEAR',title:'Little looks. Big moments.',lead:'Beautiful ethnic and occasion wear, selected with love for every celebration.',collection:'More designs coming soon.',festive:'Styles for Eid, Diwali, weddings, parties and special occasions.',size:'Our collection is available across sizes 18–38.',pricing:{'18-22':749,'24-32':999,'34-38':1199}}}; }
function loadData(){ try { const x=JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); return {products:Array.isArray(x.products)?x.products:[],settings:x.settings||defaultData().settings}; } catch(_){ return defaultData(); } }
function saveData(data){ const tmp=DATA_FILE+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, DATA_FILE); }
function loadOrders(){ try { const x=JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')); return Array.isArray(x)?x:[]; } catch(_){ return []; } }
function saveOrders(x){ try { fs.writeFileSync('/tmp/aykira-orders.json', JSON.stringify(x,null,2)); } catch (_) {} }

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = 'V21';
const razorpay = Razorpay ? new Razorpay({key_id: KEY_ID, key_secret: KEY_SECRET}) : null;

if (!KEY_ID || !KEY_SECRET) {
  console.error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in .env');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function json(res, status, body) {
  const out = JSON.stringify(body);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Accept','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});
  res.end(out);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    const MAX_BODY = 60 * 1024 * 1024; // catalogue images are sent as data URLs
    req.on('data', chunk => {
      if (tooLarge) return;
      data += chunk;
      if (Buffer.byteLength(data, 'utf8') > MAX_BODY) {
        tooLarge = true;
        reject(Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.resume();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function razorpayRequest(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.razorpay.com', path: requestPath, method,
      headers: {'Authorization': `Basic ${auth}`, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload)}
    }, r => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', c => data += c);
      r.on('end', () => {
        let parsed; try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = {}; }
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(parsed);
        else { const err = new Error(parsed?.error?.description || 'Razorpay API error'); err.statusCode = r.statusCode; reject(err); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function verifySignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, {key_id: KEY_ID});
  if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, {version: APP_VERSION});
  if (req.method === 'GET' && url.pathname === '/api/catalog') return json(res, 200, loadData());
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    let body; try { body=await readJson(req); } catch(err) { return json(res,err.code==='PAYLOAD_TOO_LARGE'?413:400,{error:err.code==='PAYLOAD_TOO_LARGE'?'Catalogue payload is too large. Please use smaller images.':'Invalid JSON.'}); }
    if (!body.password || body.password !== ADMIN_PASSWORD) return json(res,401,{success:false,error:'Wrong password.'});
    return json(res,200,{success:true});
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/save') {
    let body; try { body=await readJson(req); } catch(err) { return json(res,err.code==='PAYLOAD_TOO_LARGE'?413:400,{error:err.code==='PAYLOAD_TOO_LARGE'?'Catalogue payload is too large. Please use smaller images.':'Invalid JSON.'}); }
    if (!body.password || body.password !== ADMIN_PASSWORD) return json(res,401,{success:false,error:'Unauthorized.'});
    if (!Array.isArray(body.products) || !body.settings) return json(res,400,{error:'Invalid catalogue data.'});
    try { saveData({products:body.products,settings:body.settings}); return json(res,200,{success:true}); }
    catch(err){ console.error('Catalogue save error:',err); return json(res,500,{error:'Unable to save catalogue.'}); }
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/product-price') {
    let body; try { body=await readJson(req); } catch(err) { return json(res,400,{error:'Invalid JSON.'}); }
    if (!body.password || body.password !== ADMIN_PASSWORD) return json(res,401,{success:false,error:'Unauthorized.'});
    const id=String(body.product_id||'');
    const data=loadData(); const i=data.products.findIndex(p=>String(p.id)===id);
    if(i<0) return json(res,404,{error:'Design not found.'});
    const enabled=!!body.enabled;
    if(enabled){
      const src=body.prices||{};
      const prices={
        '18-22': Number(src['18-22']),
        '24-32': Number(src['24-32']),
        '34-38': Number(src['34-38'])
      };
      if(!Object.values(prices).every(n=>Number.isFinite(n)&&n>0)) return json(res,400,{error:'All custom prices must be greater than zero.'});
      data.products[i].customPricing={enabled:true,prices};
    } else {
      data.products[i].customPricing={enabled:false};
    }
    saveData(data);
    return json(res,200,{success:true,product:data.products[i]});
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/orders') return json(res, 200, {orders:loadOrders()});
  if (req.method === 'POST' && url.pathname === '/api/admin/order-status') {
    let body; try { body=await readJson(req); } catch (_) { return json(res,400,{error:'Invalid JSON.'}); }
    if (!body.password || body.password !== ADMIN_PASSWORD) return json(res,401,{error:'Unauthorized.'});
    const orders=loadOrders(), i=orders.findIndex(o=>o.aykira_order_id===body.order_id); if(i<0)return json(res,404,{error:'Order not found.'});
    orders[i].status=String(body.status||'New'); saveOrders(orders); return json(res,200,{success:true});
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/password') {
    return json(res,403,{error:'For this package, set AYKIRA_ADMIN_PASSWORD in .env and restart the server.'});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/pincode/')) {
    const pin=url.pathname.split('/').pop().replace(/\D/g,''); if(!/^\d{6}$/.test(pin))return json(res,400,{error:'Invalid PIN code.'});
    try { const d=await new Promise((resolve,reject)=>{const rq=https.get(`https://api.postalpincode.in/pincode/${pin}`,r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{try{resolve(JSON.parse(s))}catch(e){reject(e)}})});rq.on('error',reject)}); const po=d?.[0]; if(!po||po.Status!=='Success'||!po.PostOffice?.length) return json(res,404,{error:'PIN code not found.'}); const p=po.PostOffice[0]; return json(res,200,{city:p.District||p.Block||'',state:p.State||'',area:p.Name||''}); } catch(e){ return json(res,502,{error:'PIN lookup temporarily unavailable.'}); }
  }
  if (req.method === 'POST' && url.pathname === '/api/create-order') {
    let body;
    try { body = await readJson(req); } catch (_) { return json(res, 400, {error:'Invalid JSON.'}); }
    const amount = Number(body.amount);
    const currency = body.currency || 'INR';
    const receipt = String(body.receipt || `aykira-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
    if (!Number.isInteger(amount) || amount < 100) return json(res, 400, {error:'Amount must be an integer of at least 100 paise.'});
    if (currency !== 'INR') return json(res, 400, {error:'Only INR payments are supported.'});
    try {
      const order = razorpay
        ? await razorpay.orders.create({amount, currency, receipt})
        : await razorpayRequest('POST', '/v1/orders', {amount, currency, receipt});
      const aykira_order_id = `AYK-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const orders=loadOrders(); orders.unshift({aykira_order_id,razorpay_order_id:order.id,amount:order.amount,currency:order.currency,customer:body.customer||{},items:Array.isArray(body.items)?body.items:[],status:'Payment Pending',payment_status:'pending',created_at:new Date().toISOString()}); saveOrders(orders);
      return json(res, 200, {order_id:order.id, amount:order.amount, currency:order.currency, aykira_order_id});
    } catch (err) {
      if (err.statusCode === 401) return json(res, 401, {error:'Razorpay authentication failed. Check the API credentials.'});
      console.error('Razorpay create-order error:', err.message);
      return json(res, 500, {error:'Unable to create Razorpay order.'});
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/verify-payment') {
    let body;
    try { body = await readJson(req); } catch (_) { return json(res, 400, {error:'Invalid JSON.'}); }
    const orderId = body.razorpay_order_id;
    const paymentId = body.razorpay_payment_id;
    const signature = body.razorpay_signature;
    if (!orderId || !paymentId || !signature) return json(res, 400, {error:'Missing payment verification fields.'});
    if (!verifySignature(orderId, paymentId, signature)) return json(res, 400, {success:false, error:'Payment signature mismatch. Payment was not marked as paid.'});
    const orders=loadOrders(); const oi=orders.findIndex(o=>o.razorpay_order_id===orderId); if(oi>=0){orders[oi].payment_status='paid';orders[oi].status='New';orders[oi].razorpay_payment_id=paymentId;orders[oi].paid_at=new Date().toISOString();saveOrders(orders);}
    return json(res, 200, {success:true, payment_id:paymentId, order_id:orderId, aykira_order_id:oi>=0?orders[oi].aykira_order_id:'Confirmed'});
  }

  return json(res, 404, {error:'API endpoint not found.'});
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(__dirname, pathname));
  if (!file.startsWith(__dirname + path.sep)) return json(res, 403, {error:'Forbidden'});
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, {error:'Not found'});
    res.writeHead(200, {'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': path.extname(file).toLowerCase()==='.html' ? 'no-store' : 'public, max-age=3600'});
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS' && req.url.startsWith('/api/')) {
    res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Accept','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    json(res, 500, {error:'Internal server error.'});
  }
});
server.listen(PORT, () => console.log(`AYKIRA server running at http://localhost:${PORT}`));
