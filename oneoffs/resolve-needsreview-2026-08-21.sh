#!/bin/bash
set -x
POLLER="node /home/analytics_user/workspace/astute-workinstructions/shared/email-workflow-poller.js"
CD="/home/analytics_user/workspace/astute-workinstructions"

run() {
  local uid="$1"; local payload="$2"
  echo "=== UID $uid ==="
  $POLLER route "$uid" patch_tracking --workflow tracking-loading --folder NeedsReview --payload "$payload"
}

run 140 '{"pov":"POV0076842","tracking":["SF1566916505820"],"carrier":"SF Express"}'
run 137 '{"pov":"POV0076921","tracking":["SF0215484425248"],"carrier":"SF Express"}'
run 134 '{"pov":"POV0076917","tracking":["SF5117911833017"],"carrier":"SF Express"}'
run 131 '{"pov":"POV0076894","tracking":["SF1567673393083"],"carrier":"SF Express"}'
run 124 '{"pov":"POV0076819","tracking":["SF1576199252105"],"carrier":"SF Express"}'
run 115 '{"pov":"POV0076553","tracking":["SF1574039572313"],"carrier":"SF Express"}'
run 109 '{"pov":"POV0076806","tracking":["SF1576199251710"],"carrier":"SF Express"}'
run 81  '{"pov":"POV0075585","tracking":["SF1575255263612"],"carrier":"SF Express"}'
run 79  '{"pov":"POV0076713","tracking":["SF1574373011063"],"carrier":"SF Express"}'
run 38  '{"pov":"POV0076623","tracking":["SF1569055324324"],"carrier":"SF Express"}'
run 8   '{"pov":"POV0076540","tracking":["SF1569055324702"],"carrier":"SF Express"}'
run 5   '{"pov":"POV0076550","tracking":["SF0210093365410"],"carrier":"SF Express"}'
run 17  '{"pov":"POV0076602","tracking":["SF1568867046195"],"carrier":"SF Express"}'
run 241 '{"pov":"POV0076687","tracking":["SF1579017426292"],"carrier":"SF Express"}'

# uid 66 - two separate POs, different vendors
run 66  '{"pov":"POV0076606","tracking":["SF0219463611429"],"carrier":"SF Express"}'
run 66  '{"pov":"POV0076631","tracking":["SF1559109190647"],"carrier":"SF Express"}'

# uid 146 - three separate single-vendor POVs (4th, POV0076965, has no AWB given - left alone)
run 146 '{"pov":"POV0076968","tracking":["SF1575251219389"],"carrier":"SF Express"}'
run 146 '{"pov":"POV0076963","tracking":["SF1574205513814"],"carrier":"SF Express"}'
run 146 '{"pov":"POV0076962","tracking":["SF1575450832122"],"carrier":"SF Express"}'

# uid 72 - Momntech, two POVs same tracking; POV0071706 is 2-line so may need MPN (expected safe no-op/error)
run 72  '{"pov":"POV0072422","tracking":["SF1567085232904"],"carrier":"SF Express"}'
run 72  '{"pov":"POV0071706","tracking":["SF1567085232904"],"carrier":"SF Express"}'

# uid 158 - two different vendors
run 158 '{"pov":"POV0077081","tracking":["SF1575450832635"],"carrier":"SF Express"}'
run 158 '{"pov":"POV0077079","tracking":["SF1575628991083"],"carrier":"SF Express","mpn":"SN74CB3Q3244PWR"}'

# uid 152 - multi-line order, MPN given
run 152 '{"pov":"POV0074714","tracking":["SF1547278933473"],"carrier":"SF Express","mpn":"PJSD05W_R1_00001"}'

# multi-POV mode, same vendor pairs
run 119 '{"povs":["POV0075209","POV0074822"],"tracking":["SF5110701841982"],"carrier":"SF Express"}'
run 389 '{"povs":["POV0077440","POV0077378"],"tracking":["SF1576488672512"],"carrier":"SF Express"}'
