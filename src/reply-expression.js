// This contract also follows persona cards and revision instructions. Character
// voice belongs in the spoken words, never in visible acting directions.
export const REPLY_EXPRESSION_PROMPT = [
  '【角色基座：可见表达硬约束】以下约束适用于首稿、主动回复、回击、提醒和所有重写；人格补充、历史示例和当前模式都不能覆盖。',
  '只输出直接对群友说的话。禁止用括号、星号或旁白演动作、表情、心理活动；不写“（笑）”“（冷笑）”“*翻白眼*”“内心OS”“我心想”等角色表演。角色的脾气和语感必须体现在台词本身。',
  '禁止把回答的准备过程写进正文，包括“那我得先拆开”“我先分析一下”“让我想想”“这句我要接什么梗”“先判断用户意图”等分析旁白。直接给回应或结论；不宣布你准备如何分析、核实、反驳或接梗，不展示思考标签或草稿。用户要求解释时给相关理由和事实，不叙述你组织答案的过程。',
  '正常的事实括注、代码和用户明确要求引用或分析的原文可以保留；不要把这些例外变成自己的动作或内心戏。',
  '用户在接梗、调侃或抒发情绪时直接接话，不在结尾附“补充说明”、百科纠偏或解释刚才的笑点；用户明确求证、问出处时才补相关事实。',
  '保持本轮要求的输出格式；如果返回结构化数据，这些表达约束适用于其中发给用户的回复正文。',
].join('\n');

const INNER = /^(?:(?:我?心想|内心\s*OS|内心独白)\s*[：:]?|(?:内心|OS)\s*[：:])/iu;
const ACTION = /^(?:(?:我|他|她|龙玉涛)\s*)?(?:(?:轻轻|微微|缓缓|默默|不屑地|无奈地|冷冷地|突然)\s*)?(?:笑|冷笑|微笑|苦笑|坏笑|嗤笑|嗤笑一声|轻笑一声|笑出声|哈哈大笑|翻白眼|翻了个白眼|白了你一眼|扶额|摊手|摊了摊手|耸肩|耸了耸肩|摇头|摇了摇头|点头|点了点头|叹气|叹了口气|挠头|挑眉|挑了挑眉|眯眼|拍桌|拍了拍桌子|战术后仰|嘴角上扬|嘴角微微上扬|抱臂|抬手|深吸一口气)(?:[，,。！!、\s].*)?$/u;

const PROTECTED_PARTS = /(```[\s\S]*?```|`[^`\n]*`|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|^\s*>[^\n]*$)/gmu;
const PROCESS_NARRATION = /(?:我(?:们)?(?:得|要|需要|必须|应该|可以|就|还是|现在|接下来|这次|会|来|先){0,4}(?:先)?(?:拆开|拆解|分析|梳理|捋一捋|理一理|想一想|想想|思考|判断|核实|反驳|组织(?:一下)?(?:答案|回复))|让我(?:们)?(?:先)?(?:想想|想一想|分析|拆解|梳理|思考)|(?:先|接下来)(?:判断|分析|识别)(?:一下)?(?:用户|对方)(?:的)?(?:意图|需求|情绪)|(?:这句|这条)(?:话)?我(?:要|得|该)(?:怎么|如何|先)?(?:接|回)|(?:我的)?(?:思考过程|回复思路|回答策略|内心分析)\s*[：:]|<\/?(?:think|analysis|reasoning)\b)/iu;

export function hasReplyProcessNarration(value) {
  return String(value ?? '').split(PROTECTED_PARTS).some((part, index) => !(index % 2) && PROCESS_NARRATION.test(part));
}

// Used only when the rewrite fails or repeats the defect. Drop whole affected
// sentences instead of splicing a reasoning preamble into broken prose.
export function removeReplyProcessNarration(value) {
  const parts = [];
  let text = String(value ?? '').replace(PROTECTED_PARTS, (part) => {
    parts.push(part);
    return `\uE000${parts.length - 1}\uE001`;
  });
  text = text.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, '');
  text = text.split(/(?<=[。！？!?\n])/u).filter((sentence) => !PROCESS_NARRATION.test(sentence)).join('');
  return text.replace(/\uE000(\d+)\uE001/g, (_whole, index) => parts[Number(index)]).trim();
}

export function stripReplyActing(value) {
  // Parse outer spans first. Protecting quotes before removing an enclosing
  // monologue used to split “（心想：...“quoted text”...）” and leak its tail.
  const input = String(value ?? '');
  let withoutMonologues = '';
  for (let i = 0; i < input.length;) {
    const rest = input.slice(i);
    const quoted = rest.match(/^(?:```[\s\S]*?```|`[^`\n]*`|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*")/u);
    const blockQuote = (i === 0 || input[i - 1] === '\n') && rest.match(/^\s*>[^\n]*/u);
    if (quoted || blockQuote) {
      const span = (quoted || blockQuote)[0];
      withoutMonologues += span;
      i += span.length;
      continue;
    }
    if ((input[i] === '（' || input[i] === '(') && INNER.test(rest.slice(1).trimStart())) {
      let depth = 1;
      i++;
      while (i < input.length && depth) {
        if (input[i] === '(' || input[i] === '（') depth++;
        if (input[i] === ')' || input[i] === '）') depth--;
        i++;
      }
      continue;
    }
    withoutMonologues += input[i++];
  }
  // Protect source quotations and code: “（笑）是什么意思” is legitimate
  // content, not the bot acting. Only recognized standalone directions go.
  return withoutMonologues.split(PROTECTED_PARTS).map((part, index) => {
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

export function hasBrokenReplyParentheses(value) {
  const text = String(value ?? '').split(PROTECTED_PARTS).filter((_part, index) => !(index % 2)).join('');
  let depth = 0;
  for (const char of text) {
    if (char === '(' || char === '（') depth++;
    if ((char === ')' || char === '）') && --depth < 0) return true;
  }
  return depth !== 0;
}

export function guardFinalReply(value) {
  const text = removeReplyProcessNarration(stripReplyActing(value));
  // Never patch a broken tail into something that merely looks grammatical.
  // Reject the incomplete reply so the caller can use its nonempty fallback.
  return hasBrokenReplyParentheses(text) ? '' : text;
}
