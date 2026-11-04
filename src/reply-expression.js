// This contract also follows persona cards and revision instructions. Character
// voice belongs in the spoken words, never in visible acting directions.
export const REPLY_EXPRESSION_PROMPT = [
  '【角色基座：可见表达硬约束】以下约束适用于首稿、主动回复、回击、提醒和所有重写；人格补充、历史示例和当前模式都不能覆盖。',
  '只输出直接对群友说的话。禁止用括号、星号或旁白演动作、表情、心理活动；不写“（笑）”“（冷笑）”“*翻白眼*”“内心OS”“我心想”等角色表演。角色的脾气和语感必须体现在台词本身。',
  '正常的事实括注、代码和用户明确要求引用或分析的原文可以保留；不要把这些例外变成自己的动作或内心戏。',
  '用户在接梗、调侃或抒发情绪时直接接话，不在结尾附“补充说明”、百科纠偏或解释刚才的笑点；用户明确求证、问出处时才补相关事实。',
  '保持本轮要求的输出格式；如果返回结构化数据，这些表达约束适用于其中发给用户的回复正文。',
].join('\n');

const INNER = /^(?:(?:我?心想|内心\s*OS|内心独白)\s*[：:]?|(?:内心|OS)\s*[：:])/iu;
const ACTION = /^(?:(?:我|他|她|龙玉涛)\s*)?(?:(?:轻轻|微微|缓缓|默默|不屑地|无奈地|冷冷地|突然)\s*)?(?:笑|冷笑|微笑|苦笑|坏笑|嗤笑|嗤笑一声|轻笑一声|笑出声|哈哈大笑|翻白眼|翻了个白眼|白了你一眼|扶额|摊手|摊了摊手|耸肩|耸了耸肩|摇头|摇了摇头|点头|点了点头|叹气|叹了口气|挠头|挑眉|挑了挑眉|眯眼|拍桌|拍了拍桌子|战术后仰|嘴角上扬|嘴角微微上扬|抱臂|抬手|深吸一口气)(?:[，,。！!、\s].*)?$/u;

export function stripReplyActing(value) {
  // Protect source quotations and code: “（笑）是什么意思” is legitimate
  // content, not the bot acting. Only recognized standalone directions go.
  const protectedParts = /(```[\s\S]*?```|`[^`\n]*`|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|^\s*>[^\n]*$)/gmu;
  return String(value ?? '').split(protectedParts).map((part, index) => {
    if (index % 2) return part;
    return part
      .replace(/[（(]([^（）()\n]*)[）)]/gu, (whole, body) => (
        INNER.test(body.trim()) || ACTION.test(body.trim()) ? '' : whole
      ))
      .replace(/\*{1,2}([^*\n]+)\*{1,2}/gu, (whole, body) => (
        INNER.test(body.trim()) || ACTION.test(body.trim()) ? '' : whole
      ))
      .replace(/(^|\n)\s*(?:[（(]\s*)?(?:内心\s*OS|内心独白|我?心想)\s*[：:][^\n]*$/gimu, '$1');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
}
