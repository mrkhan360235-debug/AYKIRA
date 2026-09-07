'use strict';
const {PostgresStore,namespace}=require('../lib/storage');
async function main(){
 if(!process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_ID!=='prj_KYBJjolQFuSIJAmUtcRfgIfQQWUD')throw new Error('Build must run in the linked AYKIRA Vercel project.');
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is missing from this deployment environment. Connect the existing Neon integration.');
 if(process.env.VERCEL_ENV==='production' && (process.env.AYKIRA_ADMIN_PASSWORD||'').length<16)throw new Error('Set a unique AYKIRA_ADMIN_PASSWORD (at least 16 characters) in Vercel Production before publishing.');
 const key=String(process.env.RAZORPAY_KEY_ID||'').trim(),secret=String(process.env.RAZORPAY_KEY_SECRET||'').trim();
 console.log('Payment configuration: '+JSON.stringify({key_present:!!key,secret_present:!!secret,key_mode:key.startsWith('rzp_test_')?'test':key.startsWith('rzp_live_')?'live':'unrecognized'}));
 if(process.env.VERCEL_ENV==='preview'&&key.startsWith('rzp_test_')&&secret){
  try{const r=await fetch('https://api.razorpay.com/v1/orders?count=1',{headers:{Authorization:'Basic '+Buffer.from(key+':'+secret).toString('base64')},signal:AbortSignal.timeout(15000)});await r.arrayBuffer();console.log('Razorpay credential verification HTTP status: '+r.status);}
  catch(_){console.log('Razorpay credential verification could not reach provider.');}
 }
 const db=new PostgresStore(process.env);await db.migrate();await db.ready();
 console.log('AYKIRA database ready: '+namespace(process.env)+'. Existing records preserved.');
 console.log('Preview uses its own tables and rejects live Razorpay keys.');
 if(process.env.VERCEL_ENV==='preview'){
  const fs=require('fs'),path=require('path');
  const dir=path.join(__dirname,'../public/images');
  const name=fs.readdirSync(dir).find(n=>n.endsWith('.png'));
  try{await db.image(name,fs.readFileSync(path.join(dir,name)));console.log('Photo storage upload check passed.');}
  catch(e){let message=String(e.message||'Unknown storage error');for(const value of Object.values(process.env)){if(value&&value.length>=8)message=message.split(value).join('[redacted]');}message=message.replace(/https?:\/\/\S+/g,'[url]').slice(0,400);console.log('Photo storage check failed: '+message);}
 }
}
main().catch(e=>{console.error('AYKIRA setup failed: '+(e.message?.includes('missing')||e.message?.includes('Set a unique')||e.message?.includes('linked AYKIRA')?e.message:'Database setup could not complete. Check the linked Neon connection.'));process.exitCode=1;});
