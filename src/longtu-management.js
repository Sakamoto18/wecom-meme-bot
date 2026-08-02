const FORCE_ADD_PATTERN = /(?:强制添加|强制加入|强制存入|强制加)(?:(?:这张|这个)?(?:龙图|图片|图)(?:(?:进|到)?图库)?|(?:进|到)图库)|(?:把|将)?(?:(?:这张|这个)(?:龙图|图片|图)?|龙图)(?:强制添加|强制加入|强制加)(?:(?:进|到)?图库)?/;
const BARE_FORCE_ADD_PATTERN = /^强制(?:添加|加入|存入|收录|加)(?:图库)?$/;
const ADD_PATTERN = /(?:把|将)?(?:(?:这张|这个)(?:龙图|图片|图)?|龙图)(?:添加|加入|存入|保存|收录|加)(?:(?:进|到)?图库)?|(?:添加|加入|存入|保存|收录|加)(?:(?:这张|这个)?(?:龙图|图片|图)(?:(?:进|到)?图库)?|(?:进|到)图库)/;
const DELETE_PREVIOUS_PATTERN = /(?:删除|删掉|移除)(?:刚才|刚刚|上一张|上张)(?:发的)?龙图/;
const DELETE_THIS_PATTERN = /(?:删除|删掉|移除)(?:这张|这个)龙图|(?:这张|这个)龙图(?:删除|删掉|移除)/;
const UNDO_DELETE_PATTERN = /(?:撤销|取消)(?:刚才|刚刚|上次)?删除|恢复(?:刚才|刚刚|上次)?删除(?:的龙图)?/;
const STATUS_PATTERN = /(?:龙图|图库)(?:状态|统计|数量)|(?:状态|统计)(?:龙图|图库)/;
const SHORT_ID_PATTERN = /\bLT-[A-F0-9]{8}\b/i;
const ALIAS_STATUS_PATTERN = /^(?:(?:龙图|图库)(?:文字)?别名|(?:文字)?别名)(?:状态|统计|数量|列表|绑定)?$/;
const KEYWORD_STATUS_PATTERN = /^(?:龙图|图库)?(?:关键词|场景标签|图片标记|标记)(?:状态|统计|数量|列表|绑定)?$/;
const INSPECT_IMAGE_PATTERN = /^(?:(?:检查|查看|查询|确认)(?:一下)?(?:这张|这个)?(?:龙图|图片|图)(?:(?:是否)?(?:已经)?(?:在|进)(?:龙图)?图库(?:里|中)?(?:吗|没有)?|(?:的)?(?:标记|标签|关键词))?|(?:这张|这个)(?:龙图|图片|图)(?:(?:是否)?(?:已经)?(?:在|进)(?:龙图)?图库(?:里|中)?(?:吗|没有)?|(?:标记|标签|关键词)(?:了|有)?(?:什么|哪些)?)|(?:检查|查看)(?:图片)?标记)$/;
const INSPECT_ALIAS_PATTERNS = [
  /^(?:检查|查看|查询|确认)(?:一下)?(?:别名|标记|关键词|标签)[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:对应的?(?:图片|龙图|图))?$/,
  /^(?:别名|标记|关键词|标签)[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:绑定|对应)(?:了|的)?(?:哪张|什么)?(?:图片|龙图|图)$/,
];
const BIND_ALIAS_PATTERNS = [
  /^(?:强制)?(?:添加|加入|存入|收录)(?:(?:这张|这个)?(?:龙图|图片|图))?(?:(?:进|到)?图库)?[，,、 ]*(?:并且|同时|然后)?[，,、 ]*(?:标记|打标|加标签|绑定)(?:为|成)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /(?:把|将)?(?:这张|这个)?(?:龙图|图片|图)(?:标记|打标|加标签)(?:为|成)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /^(?:图片|龙图)?(?:标记|打标|加标签)(?:为|成)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /(?:以后|之后)?(?:再)?(?:发|说|输入|提到|喊)[“"'「『]?(.{1,48}?)[”"'」』]?(?:的时候|时)?(?:就)?(?:调用|使用|用|发|回复)(?:这张|这个)(?:龙图|图片|图)/,
  /(?:把|将)?(?:这张|这个)(?:龙图|图片|图)(?:绑定|关联|设为|设置为|指定为|固定为)(?:别名|关键词|口令)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /(?:绑定|关联|设定|设置)(?:别名|关键词|口令)?[“"'「『]?(.{1,48}?)[”"'」』]?(?:到|为)(?:这张|这个)(?:龙图|图片|图)/,
  /^(?:这张|这个)(?:图片|图|龙图)?(?:是|叫|称为|命名为|叫做|标记为|标记成)[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
];
const UNBIND_ALIAS_PATTERNS = [
  /(?:取消|删除|移除|解除)[“"'「『]?(.{1,48}?)[”"'」』]?(?:的)?(?:图片|龙图)?(?:别名)?绑定/,
  /(?:取消|删除|移除|解除)(?:别名|关键词|口令)[“"'「『]?(.{1,48}?)[”"'」』]?$/,
];
const UNBIND_IMAGE_ALIAS_PATTERNS = [
  /^(?:取消|删除|移除|解除)(?:这张|这个)(?:龙图|图片|图)(?:的)?[“\"'「『]?(.{1,48}?)[”\"'」』]?(?:标记|标签|关键词|绑定)$/,
  /^(?:把|将)?(?:这张|这个)(?:龙图|图片|图)(?:的)?[“\"'「『]?(.{1,48}?)[”\"'」』]?(?:标记|标签|关键词|绑定)(?:取消|删除|移除|解除)$/,
];
const RESERVED_ALIASES = new Set([
  '图', '图片', '龙图', '表情', '表情包', '随机', '随机图', '来一张', '发一张',
]);
const SCENE_ALIAS_STOPWORDS = new Set([
  '哈哈', '哈哈哈', '好的', '好吧', '不是', '就是', '可以', '谢谢', '你好',
  '收到', '知道', '明白', '什么', '怎么', '真的', '现在', '然后', '这个', '那个',
  '这是', '的是', '的话', '一个', '一下', '我们', '你们', '他们', '因为', '所以',
  '不过', '还是', '已经', '不会', '不能', '没有', '觉得', '时候', '东西',
]);

export function normalizeLongtuAlias(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/^[\s“”"'「」『』【】《》]+|[\s“”"'「」『』【】《》，。！？!?；;：:]+$/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (normalized.length < 2 || normalized.length > 32) return '';
  if (RESERVED_ALIASES.has(normalized) || /^LT-[A-F0-9]{8}$/i.test(normalized)) return '';
  return normalized;
}

export function formatLongtuAutoOcr(result) {
  if (result?.status === 'tagged' && result.aliases?.length > 0) {
    return `已自动识别图片文字并写入场景标记：${result.aliases.join('、')}`;
  }
  if (result?.status === 'no-text') {
    return '未识别到可靠文字，已按普通图片保存';
  }
  if (result?.status === 'failed') {
    return '图片已保存，但自动文字识别失败，已按普通图片保存';
  }
  return '';
}

function extractAlias(text, patterns) {
  for (const pattern of patterns) {
    const alias = normalizeLongtuAlias(text.match(pattern)?.[1]);
    if (alias) return alias;
  }
  return '';
}

export function parseLongtuManagementCommand(content) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const shortId = text.match(SHORT_ID_PATTERN)?.[0]?.toUpperCase() ?? '';
  const unbindImageAlias = extractAlias(text, UNBIND_IMAGE_ALIAS_PATTERNS);
  if (unbindImageAlias) {
    return {
      action: 'unbind-image-alias', force: false, shortId: '', alias: unbindImageAlias,
    };
  }
  const unbindAlias = extractAlias(text, UNBIND_ALIAS_PATTERNS);
  if (unbindAlias) {
    return { action: 'unbind-alias', force: false, shortId: '', alias: unbindAlias };
  }
  const compactText = text.replace(/\s+/g, '');
  if (ALIAS_STATUS_PATTERN.test(compactText) || KEYWORD_STATUS_PATTERN.test(compactText)) {
    return { action: 'alias-status', force: false, shortId: '', alias: '' };
  }
  if (INSPECT_IMAGE_PATTERN.test(compactText)) {
    return { action: 'inspect-image', force: false, shortId: '', alias: '' };
  }
  const inspectedAlias = extractAlias(text, INSPECT_ALIAS_PATTERNS);
  if (inspectedAlias) {
    return {
      action: 'inspect-alias', force: false, shortId: '', alias: inspectedAlias,
    };
  }
  const bindAlias = extractAlias(text, BIND_ALIAS_PATTERNS);
  if (bindAlias) {
    return {
      action: 'bind-alias',
      force: /强制/.test(text),
      shortId: '',
      alias: bindAlias,
    };
  }
  if (BARE_FORCE_ADD_PATTERN.test(text) || FORCE_ADD_PATTERN.test(text)) {
    return { action: 'add', force: true, shortId };
  }
  if (ADD_PATTERN.test(text)) return { action: 'add', force: false, shortId };
  if (DELETE_PREVIOUS_PATTERN.test(text)) return { action: 'delete-previous', shortId };
  if (DELETE_THIS_PATTERN.test(text) || (shortId && /(?:删除|删掉|移除)/.test(text))) {
    return { action: 'delete-this', shortId };
  }
  if (UNDO_DELETE_PATTERN.test(text)) return { action: 'undo-delete', shortId };
  if (STATUS_PATTERN.test(text)) return { action: 'status', shortId };
  return null;
}

function compactAliasRequest(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。！？!?；;：:]+$/g, '')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchLongtuAliasRequest(content, bindings = []) {
  const text = compactAliasRequest(content);
  if (!text) return null;
  const grouped = new Map();
  for (const binding of bindings) {
    if (!binding?.alias || !binding?.sha256 || binding.source === 'ocr') continue;
    const key = compactAliasRequest(binding.alias);
    if (!key) continue;
    const group = grouped.get(key) ?? {
      alias: binding.alias,
      source: 'manual',
      sha256s: [],
      bindings: [],
    };
    if (!group.sha256s.includes(binding.sha256)) group.sha256s.push(binding.sha256);
    group.bindings.push(binding);
    grouped.set(key, group);
  }
  const sorted = [...grouped.values()]
    // OCR 识别出的整句只参与语境匹配，不作为用户需要记忆的精确口令。
    .sort((left, right) => right.alias.length - left.alias.length);
  for (const group of sorted) {
    const alias = compactAliasRequest(group.alias);
    if (!alias) continue;
    const escaped = escapeRegExp(alias);
    const requestPattern = new RegExp(
      `^(?:(?:给我)?(?:来|发|整|甩)(?:一)?(?:张|个)?${escaped}|${escaped})(?:龙图|图片|图|表情包)?(?:吧|呗|看看)?$`,
      'i',
    );
    if (requestPattern.test(text)) {
      return { ...group, sha256: group.sha256s[0] };
    }
  }
  return null;
}

export function matchLongtuContextAlias(content, bindings = []) {
  const text = compactAliasRequest(content);
  if (!text) return null;
  const groups = new Map();
  for (const binding of bindings) {
    if (binding?.source !== 'manual' || !binding?.alias || !binding?.sha256) continue;
    const alias = compactAliasRequest(binding.alias);
    if (alias.length < 2) continue;
    const group = groups.get(alias) ?? {
      alias: binding.alias,
      source: 'manual',
      sha256s: [],
      bindings: [],
    };
    if (!group.sha256s.includes(binding.sha256)) group.sha256s.push(binding.sha256);
    group.bindings.push(binding);
    groups.set(alias, group);
  }
  const match = [...groups.entries()]
    .sort((left, right) => right[0].length - left[0].length)
    .find(([alias]) => text.includes(alias))?.[1];
  return match ? { ...match, sha256: match.sha256s[0] } : null;
}

/**
 * 根据用户原话和模型刚生成的文案，寻找最可能对应的图库文字标签。
 * 这是本地字符串匹配，不调用模型，也不会改变“发张龙图”的随机路径。
 */
export function matchLongtuSceneAliases(content, answer, bindings = []) {
  const contentText = compactAliasRequest(content);
  const answerText = compactAliasRequest(answer);
  if (!contentText && !answerText) return [];

  const sceneText = (value) => String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, '');

  // 取两段文字的最长连续公共片段。OCR 通常保存的是“玩原神玩的……”整句，
  // 用户只说“原神”或“玩原神玩的”时也应能命中，而不必把整句登记成别名。
  const longestCommonSubstring = (left, right) => {
    if (!left || !right) return '';
    let previous = new Uint16Array(right.length + 1);
    let current = new Uint16Array(right.length + 1);
    let bestLength = 0;
    let bestEnd = 0;
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      current.fill(0);
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
        current[rightIndex] = previous[rightIndex - 1] + 1;
        if (current[rightIndex] > bestLength) {
          bestLength = current[rightIndex];
          bestEnd = leftIndex;
        }
      }
      [previous, current] = [current, previous];
    }
    return left.slice(bestEnd - bestLength, bestEnd);
  };

  const normalizedContent = sceneText(contentText);
  const normalizedAnswer = sceneText(answerText);
  const prepared = bindings.flatMap((binding) => {
    const alias = compactAliasRequest(binding?.alias);
    const normalizedAlias = sceneText(alias);
    if (
      alias.length < 2
      || normalizedAlias.length < 2
      || RESERVED_ALIASES.has(alias)
      || SCENE_ALIAS_STOPWORDS.has(alias)
      || !binding?.sha256
    ) return [];
    return [{ binding, alias, normalizedAlias }];
  });

  const uniqueBySha = (entries) => [...new Map(entries.map((entry) => (
    [entry.binding.sha256, entry]
  ))).values()];

  // 管理员手动标记仍然是最高优先级的精确关系。
  const manualMatches = prepared
    .filter((entry) => (
      entry.binding.source === 'manual'
      && normalizedContent.includes(entry.normalizedAlias)
    ))
    .sort((left, right) => right.normalizedAlias.length - left.normalizedAlias.length);
  if (manualMatches.length > 0) {
    const alias = manualMatches[0].normalizedAlias;
    return uniqueBySha(manualMatches.filter((entry) => entry.normalizedAlias === alias))
      .map((entry) => ({ ...entry.binding, matchedKeyword: entry.alias }));
  }

  const findKeywordPool = (input, minimumTermLength) => {
    const boundedInput = input.slice(0, 160);
    const terms = new Set();
    const maximumTermLength = Math.min(6, boundedInput.length);
    for (let length = minimumTermLength; length <= maximumTermLength; length += 1) {
      for (let start = 0; start + length <= boundedInput.length; start += 1) {
        const term = boundedInput.slice(start, start + length);
        if (SCENE_ALIAS_STOPWORDS.has(term) || RESERVED_ALIASES.has(term)) continue;
        terms.add(term);
      }
    }

    const pools = [];
    for (const term of terms) {
      const matches = uniqueBySha(prepared.filter((entry) => (
        entry.binding.source === 'ocr'
        && entry.normalizedAlias.includes(term)
      )));
      // 两字短词只有命中多张图时才视作场景关键词池；单图短碰撞继续交给
      // 下方的长公共片段评分，避免普通聊天因常见双字词误触。
      if (matches.length < 2 && term.length < 3) continue;
      if (matches.length === 0) continue;
      pools.push({ term, matches });
    }
    pools.sort((left, right) => (
      right.matches.length - left.matches.length
      || right.term.length - left.term.length
    ));
    const best = pools[0];
    return best
      ? best.matches.map((entry) => ({
        ...entry.binding,
        matchedKeyword: best.term,
      }))
      : [];
  };

  // 用户原话里的关键词优先。一条关键词可以对应多张图片，例如“原神”会
  // 形成一个候选池，由图库的持久化洗牌策略轮换，而不是永远固定一张。
  const contentPool = findKeywordPool(normalizedContent, 2);
  if (contentPool.length > 0) return contentPool;
  const answerPool = findKeywordPool(normalizedAnswer, 3);
  if (answerPool.length > 0) return answerPool;

  const usefulOverlapLength = (overlap) => (
    overlap.length >= 2 && !SCENE_ALIAS_STOPWORDS.has(overlap)
      ? overlap.length
      : 0
  );
  const scored = [];
  for (const { binding, alias, normalizedAlias } of prepared) {
    const contentOverlap = longestCommonSubstring(normalizedContent, normalizedAlias);
    const answerOverlap = longestCommonSubstring(normalizedAnswer, normalizedAlias);
    const contentOverlapLength = usefulOverlapLength(contentOverlap);
    const answerOverlapLength = usefulOverlapLength(answerOverlap);
    const inContent = normalizedContent.includes(normalizedAlias);
    const inAnswer = normalizedAnswer.includes(normalizedAlias);
    if (contentOverlapLength < 2 && answerOverlapLength < 2) continue;
    // 仅模型文案里出现的 OCR 片段要更长，避免普通回复里的“就是你”等常见短句
    // 把语聊误判成某张图的场景；用户原话命中两字关键词即可参与匹配。
    if (binding.source !== 'manual' && contentOverlapLength < 2 && answerOverlapLength < 4) {
      continue;
    }

    let score = 0;
    score += contentOverlapLength * 10;
    score += answerOverlapLength * 6;
    if (inContent) score += 40;
    if (inAnswer) score += 12;
    if (binding.source === 'manual') score += inContent ? 1000 : 100;
    // 查询词完整包含在 OCR 整句中时，提高其优先级；这正是“玩原神玩的”
    // 匹配 OCR 文本“……玩原神玩的”的场景。
    if (normalizedContent.length >= 2 && normalizedAlias.includes(normalizedContent)) score += 80;
    if (normalizedAnswer.length >= 2 && normalizedAlias.includes(normalizedAnswer)) score += 30;
    scored.push({
      binding,
      alias,
      score,
      inContent,
      inAnswer,
      overlapLength: Math.max(contentOverlapLength, answerOverlapLength),
    });
  }

  scored.sort((left, right) => (
    right.score - left.score
    || Number(right.binding.source === 'manual') - Number(left.binding.source === 'manual')
    || right.overlapLength - left.overlapLength
    || left.alias.length - right.alias.length
  ));
  const best = scored[0];
  if (!best) return [];

  return [{ ...best.binding, matchedKeyword: best.alias }];
}

export function matchLongtuSceneAlias(content, answer, bindings = []) {
  return matchLongtuSceneAliases(content, answer, bindings)[0] ?? null;
}

export function parseAdminUsers(value) {
  return new Set(String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean));
}

export function isLongtuAdministrator(userId, adminUsers) {
  return adminUsers instanceof Set && adminUsers.has(String(userId ?? '').trim());
}

export function parseProtectedRoles(value) {
  const roles = new Map();
  for (const entry of String(value ?? '').split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const userId = entry.slice(0, separator).trim();
    const role = entry.slice(separator + 1).replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    if (userId && role) roles.set(userId, role);
  }
  return roles;
}
