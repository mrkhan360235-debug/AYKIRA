'use strict';
const {PostgresStore,namespace}=require('../lib/storage');
async function main(){
 if(!process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_ID!=='prj_KYBJjolQFuSIJAmUtcRfgIfQQWUD')throw new Error('Build must run in the linked AYKIRA Vercel project.');
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is missing from this deployment environment. Connect the existing Neon integration.');
 if(process.env.VERCEL_ENV==='production' && (process.env.AYKIRA_ADMIN_PASSWORD||'').length<16)throw new Error('Set a unique AYKIRA_ADMIN_PASSWORD (at least 16 characters) in Vercel Production before publishing.');
 const db=new PostgresStore(process.env);await db.migrate();await db.ready();
 console.log('AYKIRA database ready: '+namespace(process.env)+'. Existing records preserved.');
 console.log('Preview uses its own tables and rejects live Razorpay keys.');
}
main().catch(e=>{console.error('AYKIRA setup failed: '+(e.message?.includes('missing')||e.message?.includes('Set a unique')||e.message?.includes('linked AYKIRA')?e.message:'Database setup could not complete. Check the linked Neon connection.'));process.exitCode=1;});
