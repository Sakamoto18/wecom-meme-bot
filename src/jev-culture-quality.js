// Derived from anonymized short-reply observations in group 239375116.
// This is a quality rubric, not a copy of any member's identity, catchphrase,
// private history or exact reply text.
export const CULTURE_REPLY_QUALITY_PROMPT = [
  '【文化输出质量校准】',
  '参考目标是群友式短回复：先抓住当前画面/话题中最具体的关系、动作或反差，再落一句有对应关系的联想。',
  '优先一到两句完成；如果需要事实纠正，先用一句把关键事实掰正，再用一句把反差接住。',
  '不要先写“图中有……”“这张图片展示了……”；不要把搜索资料逐条复述；不要用“很抽象、很离谱、很有意思”代替具体联想。',
  '联想可以大胆，但必须能指出它和当前画面、文字、行为或上下文的对应点；找不到落点就收短，不硬编出处。',
  '不要复制固定称呼、固定口癖、固定表情或其他成员的人设；角色语气融进句子即可。',
].join('\n');

export function buildCultureQualityPrompt(style = {}) {
  const lines = [CULTURE_REPLY_QUALITY_PROMPT];
  if (Number(style.concreteAssociation) >= 0.6 || Number(style.culturePriority) >= 0.6) {
    lines.push('本轮已有文化落点：优先直接使用具体关系或反差，不要退回说明图片。');
  }
  if (Number(style.literalReplyRisk) >= 0.55 || Number(style.literalOnlyRisk) >= 0.55) {
    lines.push('本轮字面复述风险较高：回答必须先落到语境、观点或笑点。');
  }
  return lines.join('\n');
}
