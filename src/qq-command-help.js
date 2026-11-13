const ADMIN_SLASH_COMMANDS = [
  ['/指令', '查看这份超管斜杠指令清单。'],
  ['/add', '引用图片或同消息附图，强制加入龙图库。'],
  ['/tag 标记名', '给当前图片绑定一个龙图文字标记。'],
  ['/del [LT-XXXXXXXX]', '删除引用图片，或按短 ID 删除图库图片。'],
  ['/rel 词1|词2|词3', '保存一组相关词，让选图共享候选池。'],
  ['/rel-list', '查看已保存的相关词族。'],
  ['/rel-del 词族名', '删除一组相关词族。'],
  ['/rel-import 词族名', '批量导入已有词族：开启后在当前会话连续发图、多图或合并转发；仅收操作者的图，15 分钟无导入操作自动退出。'],
  ['/rel-import-status', '查看当前词族批量导入进度。'],
  ['/rel-import-end', '结束批量导入（也可发“结束导入”）；已导入图片保留。'],
  ['/rel-index-status', '查看图库文字、场景识别及自动词族归类进度；普通对话会按语境选图。'],
  ['/stop', '停止当前群的 Bot 回复和连续话题。仅群聊生效。'],
  ['/usage-report [YYYY-MM-DD]', '查看今日或指定日期的用量日报。'],
  ['/learn-retry [YYYY-MM-DD]', '管理员补学最近或指定日期日报里失败的视频，完成后在当前会话单独发报告；也可说“重学昨天失败的视频”。已成功或候选不会重复学习。'],
  ['/learn-retry-status', '查看当前会话的补学进度或完成报告；也可说“补学进度”“补学报告”。预算不足自动次日继续。'],
  ['/learn-meme 梗名', '指定梗重新联网学习，经独立置信度审核后返回报告；仅高置信结果更新共享梗库。普通成员可用，群里需 @机器人或引用机器人；也支持“联网学习 XXX 这个梗”。'],
  ['/learn-status', '查询本群/私聊最近一次联网学习的阶段、耗时和结果；也可说“学习进度”。群内需 @机器人。'],
  ['/learn-list [关键词]', '列出本会话最近报告的梗名、时间和状态；可用 #序号选择，无需记报告编号。'],
  ['/learn-review [#序号|梗名|最近] [| 具体结论]', '管理员预览待入库内容，默认只选梗义和用法，也可竖线后指定一条结论；10 分钟内确认生效。'],
  ['/learn-confirm', '管理员确认自己在当前会话预览的内容入库；保留原机器评分和人工确认记录。'],
  ['/learn-cancel', '取消自己的待确认预览。'],
  ['/learn-report [#序号|梗名]', '补取本群/私聊最近一次完整学习报告，不重新学习；也可说“学习报告”。群内需 @机器人。'],
  ['/persona [help|train|start]', '查看人格训练说明或开始训练。'],
  ['/persona [save|confirm]', '确认保存待确认的人格补充。'],
  ['/persona [cancel|reject]', '取消待确认的人格补充。'],
  ['/persona [preview|pending]', '查看待确认的人格补充。'],
  ['/persona [list|status]', '查看当前生效的人格配置。'],
  ['/persona [undo|revert] [scope]', '回退指定范围的人格版本。'],
  ['/persona [off|disable] [scope]', '停用指定范围的人格配置。'],
  ['/persona [add|rule|phrase|example] ...', '新增表达规则、口癖或输入输出示例。'],
  ['/persona replace <global|group|user> ...', '完整替换指定范围的人格，确认后生效；旧版可回退。global/group 仅超管可用。'],
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
    '学习报告可由管理员直接回复“入库”或“确认入库”，不必先预览；多份时说“入库 梗名”。',
    '说明：带“私聊”的命令请在私聊中发送；图库命令通常需要附图或引用图片。',
    '未列出的 / 开头内容会被静默拦截，不会交给模型或其他插件。',
  ].join('\n');
}

export { ADMIN_SLASH_COMMANDS };
