'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const seed=require('../seed/catalog.json');
const error=(status,message)=>Object.assign(new Error(message),{status});
const clone=v=>structuredClone(v);

// Used only for local development/tests. Hosted requests never fall back to files.
class FileStore {
 constructor(dir){this.dir=dir;this.sessions=new Map();this.limits=new Map();fs.mkdirSync(dir,{recursive:true});this.file=path.join(dir,'store.json');if(!fs.existsSync(this.file))this.write({catalog:clone(seed),orders:{}});}
 read(){return JSON.parse(fs.readFileSync(this.file,'utf8'));}
 write(data){const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,this.file);}
 async ready(){return true;}
 async catalog(){return this.read().catalog;}
 async saveCatalog(data,revision){const s=this.read();if(s.catalog.revision!==revision)throw error(409,'The catalogue changed in another tab. Reload before saving.');s.catalog={...data,revision:revision+1};this.write(s);return s.catalog;}
 async readOrder(id){const o=this.read().orders[id];if(!o)throw error(404,'Order not found.');return o;}
 async findOrder(id){return Object.values(this.read().orders).find(o=>o.razorpay_order_id===id);}
 async listOrders(){return Object.values(this.read().orders).sort((a,b)=>b.created_at.localeCompare(a.created_at));}
 async claimOrder(o){const s=this.read();if(s.orders[o.aykira_order_id])return false;s.orders[o.aykira_order_id]=o;this.write(s);return true;}
 async attachPaymentOrder(id,razorId){const s=this.read(),o=s.orders[id];o.razorpay_order_id=razorId;this.write(s);return o;}
 async markPaid(id,p){const s=this.read(),o=s.orders[id];if(o.payment_status!=='paid'){o.payment_status='paid';o.razorpay_payment_id=p.id;o.paid_at=new Date().toISOString();if(o.status==='Payment Pending')o.status='New';this.write(s);}return o;}
 async setStatus(id,status){const s=this.read(),o=s.orders[id];if(!o)throw error(404,'Order not found.');if(o.payment_status!=='paid'&&status!=='Cancelled')throw error(409,'Payment has not been confirmed.');o.status=status;this.write(s);return o;}
 async createSession(hash,csrf,expires){this.sessions.set(hash,{csrf,expires});}
 async session(hash){const s=this.sessions.get(hash);return s&&s.expires>Date.now()?s:null;}
 async deleteSession(hash){this.sessions.delete(hash);}
 async rate(key,max){const minute=Math.floor(Date.now()/60000),k=key+minute;if(this.limits.size>5000)this.limits.clear();const n=(this.limits.get(k)||0)+1;this.limits.set(k,n);return n<=max;}
 async image(name,bytes){const dir=path.join(this.dir,'uploads');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name),bytes);return '/uploads/'+name;}
}

function namespace(env){return env.VERCEL_ENV==='preview'?'aykira_v23_preview':'aykira_v23';}
class PostgresStore {
 constructor(env,driver){this.env=env;this.schema=namespace(env);this.driver=driver;}
 db(){if(!this.driver){if(!this.env.DATABASE_URL)throw error(503,'Store database is not configured.');const {neon}=require('@neondatabase/serverless');this.driver=neon(this.env.DATABASE_URL);}return this.driver;}
 query(statement,params=[]){return this.db().query(statement,params,{fetchOptions:{signal:AbortSignal.timeout(15000)}});}
 async ready(){await this.query(`SELECT revision FROM ${this.schema}.catalog WHERE id=1`);return true;}
 async migrate(){
  // Additive, namespaced schema only. Existing tables and rows are never dropped.
  const s=this.schema;
  const statements=[
   `CREATE SCHEMA IF NOT EXISTS ${s}`,
   `CREATE TABLE IF NOT EXISTS ${s}.catalog (id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL, revision integer NOT NULL DEFAULT 1)`,
   `CREATE TABLE IF NOT EXISTS ${s}.orders (id text PRIMARY KEY, razorpay_order_id text UNIQUE, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
   `CREATE INDEX IF NOT EXISTS orders_created_at_idx ON ${s}.orders(created_at DESC)`,
   `CREATE TABLE IF NOT EXISTS ${s}.sessions (token_hash text PRIMARY KEY, csrf text NOT NULL, expires_at timestamptz NOT NULL)`,
   `CREATE TABLE IF NOT EXISTS ${s}.rate_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL)`,
   `CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON ${s}.sessions(expires_at)`,
   `CREATE INDEX IF NOT EXISTS rate_limits_expiry_idx ON ${s}.rate_limits(expires_at)`
  ];
  await this.db().transaction(statements.map(q=>this.db().query(q)),{isolationLevel:'Serializable'});
  const {revision,...data}=seed;
  await this.query(`INSERT INTO ${s}.catalog (id,data,revision) VALUES (1,$1::jsonb,1) ON CONFLICT(id) DO NOTHING`,[JSON.stringify(data)]);
 }
 async catalog(){const [row]=await this.query(`SELECT data,revision FROM ${this.schema}.catalog WHERE id=1`);if(!row)throw error(503,'Catalogue setup is incomplete.');return {...row.data,revision:row.revision};}
 async saveCatalog(data,revision){const [row]=await this.query(`UPDATE ${this.schema}.catalog SET data=$1::jsonb,revision=revision+1 WHERE id=1 AND revision=$2 RETURNING data,revision`,[JSON.stringify(data),revision]);if(!row)throw error(409,'The catalogue changed in another tab. Reload before saving.');return {...row.data,revision:row.revision};}
 async readOrder(id){const [row]=await this.query(`SELECT data FROM ${this.schema}.orders WHERE id=$1`,[id]);if(!row)throw error(404,'Order not found.');return row.data;}
 async findOrder(id){if(typeof id!=='string')return undefined;const [row]=await this.query(`SELECT data FROM ${this.schema}.orders WHERE razorpay_order_id=$1`,[id]);return row?.data;}
 async listOrders(){return (await this.query(`SELECT data FROM ${this.schema}.orders ORDER BY created_at DESC LIMIT 500`)).map(x=>x.data);}
 async claimOrder(o){const rows=await this.query(`INSERT INTO ${this.schema}.orders (id,data) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id`,[o.aykira_order_id,JSON.stringify(o)]);return rows.length===1;}
 async attachPaymentOrder(id,razorId){const [r]=await this.query(`UPDATE ${this.schema}.orders SET razorpay_order_id=$2,data=data||jsonb_build_object('razorpay_order_id',$2::text) WHERE id=$1 RETURNING data`,[id,razorId]);return r.data;}
 async markPaid(id,p){
  const [row]=await this.query(`UPDATE ${this.schema}.orders SET data=data||jsonb_build_object('payment_status','paid','razorpay_payment_id',$2::text,'paid_at',$3::text,'status',CASE WHEN data->>'status'='Payment Pending' THEN 'New' ELSE data->>'status' END) WHERE id=$1 AND data->>'payment_status'<>'paid' RETURNING data`,[id,p.id,new Date().toISOString()]);
  return row?.data||await this.readOrder(id);
 }
 async setStatus(id,status){const [row]=await this.query(`UPDATE ${this.schema}.orders SET data=data||jsonb_build_object('status',$2::text) WHERE id=$1 AND (data->>'payment_status'='paid' OR $2='Cancelled') RETURNING data`,[id,status]);if(!row){await this.readOrder(id);throw error(409,'Payment has not been confirmed.');}return row.data;}
 async createSession(hash,csrf,expires){await this.query(`INSERT INTO ${this.schema}.sessions (token_hash,csrf,expires_at) VALUES ($1,$2,$3)`,[hash,csrf,new Date(expires).toISOString()]);await this.query(`DELETE FROM ${this.schema}.sessions WHERE expires_at<now()`);}
 async session(hash){const [s]=await this.query(`SELECT csrf,expires_at FROM ${this.schema}.sessions WHERE token_hash=$1 AND expires_at>now()`,[hash]);return s?{csrf:s.csrf,expires:new Date(s.expires_at).getTime()}:null;}
 async deleteSession(hash){await this.query(`DELETE FROM ${this.schema}.sessions WHERE token_hash=$1`,[hash]);}
 async rate(key,max){const [r]=await this.query(`INSERT INTO ${this.schema}.rate_limits (key,count,expires_at) VALUES ($1,1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN ${this.schema}.rate_limits.expires_at<now() THEN 1 ELSE ${this.schema}.rate_limits.count+1 END,expires_at=CASE WHEN ${this.schema}.rate_limits.expires_at<now() THEN now()+interval '1 minute' ELSE ${this.schema}.rate_limits.expires_at END RETURNING count`,[key]);return r.count<=max;}
 async image(name,bytes){if(!this.env.PRODUCTS_BLOB_READ_WRITE_TOKEN)throw error(503,'Photo storage is not configured.');const {put}=require('@vercel/blob');const ext=path.extname(name);const blob=await put(`${this.schema}/products/${name}`,bytes,{access:'public',token:this.env.PRODUCTS_BLOB_READ_WRITE_TOKEN,contentType:{'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[ext],addRandomSuffix:false,allowOverwrite:true,cacheControlMaxAge:31536000});return blob.url;}
}
module.exports={FileStore,PostgresStore,namespace};
