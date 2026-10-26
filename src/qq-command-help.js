const ADMIN_SLASH_COMMANDS = [
  ['/指令', '查看这份超管斜杠指令清单。'],
  ['/add', '引用图片或同消息附图，强制加入龙图库。'],
  ['/tag 标记名', '给当前图片绑定一个龙图文字标记。'],
  ['/del [LT-XXXXXXXX]', '删除引用图片，或按短 ID 删除图库图片。'],
  ['/rel 词1|词2|词3', '保存一组相关词，让选图共享候选池。'],
  ['/rel-list', '查看已保存的相关词族。'],
  ['/rel-del 词族名', '删除一组相关词族。'],
  ['/stop', '停止当前群的 Bot 回复和连续话题。仅群聊生效。'],
  ['/usage-report [YYYY-MM-DD]', '查看今日或指定日期的用量日报。'],
  ['/persona [help|train|start]', '查看人格训练说明或开始训练。'],
  ['/persona [save|confirm]', '确认保存待确认的人格补充。'],
  ['/persona [cancel|reject]', '取消待确认的人格补充。'],
  ['/persona [preview|pending]', '查看待确认的人格补充。'],
  ['/persona [list|status]', '查看当前生效的人格配置。'],
  ['/persona [undo|revert] [scope]', '回退指定范围的人格版本。'],
  ['/persona [off|disable] [scope]', '停用指定范围的人格配置。'],
  ['/persona [add|rule|phrase|example] ...', '新增表达规则、口癖或输入输出示例。'],
  ['/persona global ...', '保存全局人格补充。仅超管可管理全局范围。'],
  ['/persona group ...', '保存当前群的人格补充。仅超管可管理群范围。'],
  ['/jev on|off|auto|shadow|status', '切换或查看 Jev 门控模式。'],
  ['/crazy-thursday [test]', '私聊随机测试一条疯狂星期四文案。'],
  ['/crazy-thursday-add 文案', '私聊把一条文案加入本地文案池。'],
  ['/crazy-thursday-list', '私聊查看本地文案池。'],
  ['/crazy-thursday-del 编号', '私聊删除本地文案池中的一条文案。'],
];

export function isSlashCommandHelp(value) {
  const text = String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return text === '/指令';
}

export function formatAdminSlashCommandHelp() {
  return [
    '超管可用的斜杠指令：',
    ...ADMIN_SLASH_COMMANDS.map(([command, description]) => `${command}：${description}`),
    '',
    '说明：带“私聊”的命令请在私聊中发送；图库命令通常需要附图或引用图片。',
    '未列出的 / 开头内容会被静默拦截，不会交给模型或其他插件。',
  ].join('\n');
}

export { ADMIN_SLASH_COMMANDS };
