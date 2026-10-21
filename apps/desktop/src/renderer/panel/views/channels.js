// 群机器人管理（设置页；对话里「发到群」时使用）
import { h, api, run, modal, toast } from '../lib.js';

const TYPES = { feishu: '飞书群', wecom: '企业微信群', dingtalk: '钉钉群', webhook: '其他 Webhook' };

export async function manageChannels(onSaved) {
  const { settings } = await api('settingsGet');
  const items = structuredClone(settings.channels || []);
  const list = h('div');
  const draw = () =>
    list.replaceChildren(
      ...items.map((c, i) => {
        const name = h('input.input', { value: c.name, placeholder: '名称，如：项目组群' });
        const type = h('select.input', Object.entries(TYPES).map(([v, l]) => h('option', { value: v }, l)));
        type.value = c.type || 'feishu';
        const hook = h('input.input', { type: 'password', value: c.webhook, placeholder: '机器人 Webhook 地址' });
        const sec = h('input.input', { type: 'password', value: c.secret, placeholder: '加签密钥（没有可不填）' });
        const sync = () => Object.assign(items[i], { name: name.value.trim(), type: type.value, webhook: hook.value, secret: sec.value });
        for (const el of [name, type, hook, sec]) el.addEventListener('change', sync);
        return h(
          'div.channel',
          h('div.row', name, type),
          h('div', { style: { height: '6px' } }),
          hook,
          h('div', { style: { height: '6px' } }),
          sec,
          h('div.row.end', { style: { marginTop: '6px' } }, c.id ? h('button.btn.sm', { onclick: () => run(() => api('channelTest', c.id), '测试消息已发送') }, '发条测试') : '', h('button.btn.sm.danger', { onclick: () => (items.splice(i, 1), draw()) }, '删除'))
        );
      }),
      items.length ? '' : h('div.small.muted', '在群设置 → 群机器人 → 添加「自定义机器人」，复制它的 Webhook 地址填到这里。')
    );
  draw();
  modal('群机器人', h('div', list, h('button.btn.sm', { onclick: () => (items.push({ name: '', type: 'feishu', webhook: '', secret: '' }), draw()) }, '＋ 添加')), [
    { label: '取消', onClick: (c) => c() },
    {
      label: '保存',
      kind: 'primary',
      onClick: async (close) => {
        if (items.some((c) => !c.name)) return toast('请填写名称', 'err');
        if (await run(() => api('settingsSave', { channels: items }), '已保存')) {
          close();
          onSaved?.();
        }
      },
    },
  ]);
}
