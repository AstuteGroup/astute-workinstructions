#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

const result = psqlQuery(`
  SELECT rl.chuboe_rfq_line_id, rl.line, rlm.chuboe_mpn
  FROM adempiere.chuboe_rfq_line rl
  LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
  WHERE rl.chuboe_rfq_id = 1148927
    AND rl.isactive = 'Y'
    AND rl.line >= 250
  ORDER BY rl.line;
`);
console.log('Lines >= 250:');
console.log(result || '(none)');
