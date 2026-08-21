require('dotenv').config({path:'/home/analytics_user/workspace/.env'});
const {ImapFlow} = require('imapflow');
(async () => {
  const client = new ImapFlow({host: process.env.IMAP_HOST||'imap.mail.us-east-1.awsapps.com', port: 993, secure:true, auth:{user:'tracking@orangetsunami.com', pass: process.env.WORKMAIL_PASS}, logger:false});
  await client.connect();
  const list = await client.list();
  for (const m of list) {
    const status = await client.status(m.path, {messages:true, unseen:true}).catch(e=>({error:e.message}));
    console.log(m.path, JSON.stringify(status));
  }
  await client.logout();
})();
