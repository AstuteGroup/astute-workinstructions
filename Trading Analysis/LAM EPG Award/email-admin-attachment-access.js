/**
 * Email Chuck requesting AD_Attachment read access for our API role.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createNotifier } = require('../../shared/notifier');

const body = `Hi Chuck,

We've been using the iDempiere REST API (Claude Harris user, Tsunami User role ID 1000004) to read and write data, and it's been working well for models, printing, etc.

We've hit one gap: we can't retrieve Document Explorer attachments via the API. When we call:

  GET /api/v1/models/C_Order/{id}/attachments

...it returns empty {"attachments":[]} even though there are files visible in Document Explorer in the UI. We also get 403 when querying AD_Attachment directly.

Could you grant the Tsunami User role (ID 1000004) read access to the AD_Attachment table? That should let the REST API return attachment files the same way the UI does.

Use case: we're pulling Infor POV copies (PDFs stored on C_Order records via Document Explorer) as part of the LAM EPG order processing workflow. Being able to retrieve these programmatically saves manual download time.

Happy to test once it's in place — the scripts are ready to go.

Thanks,
Jake (via analytics terminal)
`;

const notifier = createNotifier({
  fromEmail: 'vortex@orangetsunami.com',
  fromName: 'Analytics Terminal',
  smtpPass: process.env.WORKMAIL_PASS,
});

notifier.sendWithAttachment(
  'jake.harris@Astutegroup.com',
  'Request: AD_Attachment read access for Tsunami User role (REST API)',
  body,
  [],
).then(ok => console.log(ok ? '✓ Email sent' : '✗ Email failed'))
 .catch(e => { console.error(e); process.exit(1); });
