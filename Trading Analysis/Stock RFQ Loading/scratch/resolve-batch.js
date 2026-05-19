// Resolves partner lookups for the current batch of stockrfq senders
const { resolvePartner } = require('../../../shared/partner-lookup');

const senders = [
  { email: 'grace@asw-tech.com', company: 'Shenzhen A.S.W Technology Co., Ltd' },
  { email: 'vivian@hykjsz.cn', company: 'Shenzhen Lilai Technology Co., Ltd' },
  { email: 'helen@suncode-st.com', company: 'SUNCODE Electronics' },
  { email: 'purchase-6@aidapuli.cn', company: 'Shenzhen Aidapuli Electronics Co., Ltd' },
  { email: 'nanju@corebanner.com', company: 'Core Banner Electronic Technology HK Limited' },
  { email: 'leo@yingzhan.xin', company: 'Yingzhan Electronics Co., LTD' },
  { email: 'evelyn@wylfz.com', company: 'Shenzhen Weiyali Development Co., Ltd.' },
  { email: 'cassie_lee@szpengyuan.cn', company: 'Shenzhen Pengyuan Microelectronics Co., Ltd' },
  { email: 'nora-lee6@qq.com', company: null },
  { email: 'stella@zhiyuic.com', company: 'Shenzhen Zhi Yu Technology Co., Ltd' },
  { email: 'fiona@asw-tech.com', company: 'Shenzhen A.S.W Technology Co., Ltd' },
  { email: 'hezhiliangreg2022@163.com', company: null },
  { email: 'glen@keyunxin.net', company: 'Shenzhen Keyunxin Elec' },
  { email: 'daisy@igzrc.cn', company: 'Shenzhen Mingsheng Electronics Co., Ltd.' },
  { email: 'ella@xinboshi.com.cn', company: 'Xinboshi Electronics Co., Ltd' },
  { email: 'isla@zhiyuic.com', company: 'Shenzhen Zhi Yu Technology Co., Ltd' },
  { email: 'evelyn@asw-tech.com', company: 'Shenzhen A.S.W Technology Co., Ltd' },
  { email: 'lee18888@yeah.net', company: 'nicebay electronics co., ltd' },
  { email: 'yuli.ruan@compo.com.hk', company: 'Compo Electronics Asia Limited' },
  { email: 'jadeluck@163.com', company: null },
  { email: 'jhoonwanna@163.com', company: 'Shenzhen Runyou Co., Ltd' },
  { email: 'darren@yxyelectronic.com', company: 'Shenzhen Yixinyan Electronics Co., Ltd' },
  { email: 'yulia@igzrc.cn', company: 'Shenzhen Mingsheng Electronics Co., Ltd.' },
  { email: 'chloe@mhchips.com', company: 'Dongguan Maihong Metal & Electronic Technology Co., Ltd.' },
  { email: 'sophia@zkxwic.com', company: 'ZHONGKAI MICROELECTRONICS (HK) CO., LIMITED' },
  { email: 'felix@szpengyuan.cn', company: 'Shenzhen Pengyuan Microelectronics Co., Ltd' },
  { email: 'caden@hanchentech.com', company: 'HANGCHENG ELECTRONICS INTERNATIONAL LIMITED' },
  { email: 'kyle@szpengyuan.cn', company: 'Shenzhen Pengyuan Microelectronics Co., Ltd' },
  { email: 'ethan88f@163.com', company: 'Hong Kong Semiconductor Technology' },
  { email: 'ellie@szpengyuan.cn', company: 'Shenzhen Pengyuan Microelectronics Co., Ltd' },
  { email: 'alice@chenguang-ic.com', company: 'Shenzhen Chenguang Electronic Technology Co., Ltd' },
  { email: 'narendrababurajaraman.naren@converge.com', company: 'Converge' },
  { email: 'tamara@bulechip.com', company: 'BlueCore Intelligence (Shenzhen) Co., Ltd.' },
  { email: 'leah@szpengyuan.cn', company: 'Shenzhen Pengyuan Microelectronics Co., Ltd' },
  { email: 'fiona@elysianic.cn', company: null },
  { email: 'leewei@dongxinhk.com', company: 'Shenzhen Yigou Xincheng Elec' },
  { email: 'bonnie.chan@lingjunictech.com', company: 'Shenzhen Hengchenxin Tech' },
  { email: 'lily@yudexin-tech.com', company: 'Shenzhen Yudexin Electronic Technology Co., Ltd' },
  { email: 'wanhongpin@wqpgx.cn', company: 'Shenzhen Kelicheng Electronics' },
  { email: 'lennox1011@163.com', company: 'JZchips electronics limited' },
  { email: 'henry@asw-tech.com', company: 'Shenzhen A.S.W Technology Co., Ltd' },
  { email: 'ashish.salvaji@formixinternational.com', company: 'FORMIX INTERNATIONAL INDIA PVT. LTD.' },
  { email: 'daisy@asw-tech.com', company: 'Shenzhen A.S.W Technology Co., Ltd' },
  { email: 'henry_apexmail@163.com', company: 'apexmail Technology Co., Ltd.' },
  { email: 'isabella@wylfz.com', company: 'Shenzhen Weiyali Development Co., Ltd.' },
  { email: 'ethansage@163.com', company: 'Yunduan Intelligence Co., Ltd.' },
];

(async () => {
  const out = {};
  for (const s of senders) {
    try {
      const r = await resolvePartner({ email: s.email, companyName: s.company, partnerType: 'customer' });
      out[s.email] = r ? { id: r.c_bpartner_id, name: r.name, match: r.matched_on } : null;
    } catch (e) {
      out[s.email] = { error: e.message };
    }
  }
  console.log(JSON.stringify(out, null, 2));
})();
