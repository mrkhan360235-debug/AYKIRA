'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const file=path.join(__dirname,'.env');
if(fs.existsSync(file)){
  console.log('Existing .env kept. Admin password and payment settings are managed in that file.');
}else{
  const password=crypto.randomBytes(24).toString('base64url');
  const content=fs.readFileSync(path.join(__dirname,'.env.example'),'utf8').replace('AYKIRA_ADMIN_PASSWORD=','AYKIRA_ADMIN_PASSWORD='+password);
  fs.writeFileSync(file,content,{mode:0o600,flag:'wx'});
  console.log('AYKIRA setup complete. Your local admin password is: '+password);
  console.log('Keep this password private. You can also find it in .env.');
  console.log('Catalogue and admin work now. Add new Razorpay test credentials to .env to test payments.');
}
