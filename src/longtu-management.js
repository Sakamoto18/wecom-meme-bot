import { containsLongtuTag, longtuTagInput, matchRelatedLongtuTags } from './longtu-tag-relations.js';

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
const SLASH_COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const ALLOWED_SLASH_COMMANDS = new Set([
  'add', 'tag', 'del', 'rel', 'rel-list', 'rel-del',
]);
const SHORT_ID_EXACT_PATTERN = /^LT-[A-F0-9]{8}$/i;

export function normalizeLongtuAlias(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/^[\s“”"'「」『』【】《》]+|[\s“”"'「」『』【】《》，。！？!?；;：:]+$/g, '')
    .replace(/\s+/g, '')
    .trim();
  // 管理员显式输入的单字标记也是合法关键词（例如“钱”）。普通对话的
  // 场景自动匹配仍在下方单独要求至少 2 个字符，避免单字误触图片。
  if (normalized.length < 1 || normalized.length > 32) return '';
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

/**
 * 只解析明确允许的图库及词族管理斜杠命令。
 * 其他以 / 开头的内容返回 ignored-slash，调用方必须静默丢弃，不能继续交给模型。
 */
export function parseLongtuSlashCommand(content) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!text.startsWith('/')) return null;
  const matched = text.match(SLASH_COMMAND_PATTERN);
  if (!matched) {
    return { action: 'ignored-slash', force: false, shortId: '', alias: '' };
  }
  const command = matched[1].toLowerCase();
  const argument = String(matched[2] ?? '').trim();
  if (!ALLOWED_SLASH_COMMANDS.has(command)) {
    return { action: 'ignored-slash', force: false, shortId: '', alias: '' };
  }
  if (command === 'add') {
    return argument
      ? {
        action: 'invalid-slash',
        force: true,
        shortId: '',
        alias: '',
        message: '用法：/add（请在同一条消息附图，或引用图片后发送）',
      }
      : { action: 'add', force: true, shortId: '', alias: '' };
  }
  if (command === 'tag') {
    const alias = normalizeLongtuAlias(argument);
    return alias
      ? { action: 'bind-alias', force: true, shortId: '', alias }
      : {
        action: 'invalid-slash',
        force: true,
        shortId: '',
        alias: '',
        message: '用法：/tag 标记名（请在同一条消息附图、引用图片，或先使用 /add）',
      };
  }
  if (command === 'rel-list') {
    return argument
      ? {
        action: 'invalid-slash', force: false, shortId: '', alias: '',
        message: '用法：/rel-list（查看当前词族）',
      }
      : { action: 'relation-list', force: false, shortId: '', alias: '' };
  }
  if (command === 'rel-del') {
    const relationId = parseRelationId(argument);
    return relationId
      ? {
        action: 'relation-delete', force: false, shortId: '', alias: '', relationId,
      }
      : {
        action: 'invalid-slash', force: false, shortId: '', alias: '',
        message: '用法：/rel-del 词族名',
      };
  }
  if (command === 'rel') {
    if (!argument) {
      return {
        action: 'invalid-slash', force: false, shortId: '', alias: '',
        message: '用法：/rel 词1|词2|词3，或 /rel 词族名=词1|词2|词3',
      };
    }
    const separator = argument.search(/[=:：]/u);
    const relationId = separator >= 0
      ? parseRelationId(argument.slice(0, separator))
      : '';
    const terms = parseRelationTerms(separator >= 0
      ? argument.slice(separator + 1)
      : argument);
    const effectiveId = relationId || terms[0] || '';
    if (!effectiveId || terms.length < 2 || !terms.some((term) => term.length >= 2)) {
      return {
        action: 'invalid-slash', force: false, shortId: '', alias: '',
        message: '用法：/rel 词1|词2|词3，至少提供两个词；也可写 /rel 词族名=词1|词2|词3',
      };
    }
    return {
      action: 'relation-upsert', force: false, shortId: '', alias: '',
      relationId: effectiveId, relationTerms: terms,
    };
  }
  if (!argument) {
    return { action: 'delete-this', force: false, shortId: '', alias: '' };
  }
  if (SHORT_ID_EXACT_PATTERN.test(argument)) {
    return { action: 'delete-this', force: false, shortId: argument.toUpperCase(), alias: '' };
  }
  return {
    action: 'invalid-slash',
    force: false,
    shortId: '',
    alias: '',
    message: '用法：/del（引用要删除的图片）或 /del LT-XXXXXXXX',
  };
}

export function parseLongtuManagementCommand(content) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const slashCommand = parseLongtuSlashCommand(text);
  if (slashCommand) return slashCommand;
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

function parseRelationTerms(value) {
  return [...new Set(String(value ?? '')
    .split(/[|,，、\s]+/u)
    .map((term) => normalizeLongtuAlias(term))
    .filter(Boolean))];
}

function parseRelationId(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 48);
}

export function matchLongtuAliasRequest(content, bindings = [], options = {}) {
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
  let exactMatch = null;
  for (const group of sorted) {
    const alias = compactAliasRequest(group.alias);
    if (!alias) continue;
    const escaped = escapeRegExp(alias);
    const requestPattern = new RegExp(
      `^(?:(?:给我)?(?:来|发|整|甩)(?:一)?(?:张|个)?${escaped}|${escaped})(?:龙图|图片|图|表情包)?(?:吧|呗|看看)?$`,
      'i',
    );
    if (requestPattern.test(text)) {
      exactMatch = { ...group, sha256: group.sha256s[0] };
      break;
    }
  }

  // A manually registered alias remains the direct-request anchor, but a
  // configured relation group expands its candidate pool so the persistent
  // picker can rotate among related images instead of returning one fixed
  // hash forever (for example “nm” -> “nmb/mlgb/你妈”).
  const related = matchRelatedLongtuTags(content, bindings, {
    ...options,
    allowHostile: options.allowHostile !== false,
  });
  if (exactMatch) {
    const merged = new Map();
    for (const binding of [...(exactMatch.bindings ?? []), ...related]) {
      if (binding?.sha256 && !merged.has(binding.sha256)) merged.set(binding.sha256, binding);
    }
    return {
      ...exactMatch,
      sha256s: [...merged.keys()],
      bindings: [...merged.values()],
    };
  }
  const directText = text
    .replace(/^(?:给我)?(?:来|发|整|甩)(?:一)?(?:张|个)?/u, '')
    .replace(/(?:龙图|图片|图|表情包)?(?:吧|呗|看看)?$/u, '');
  const directRelated = related.filter((entry) => (
    directText && normalizeLongtuAlias(entry.matchedKeyword) === directText
  ));
  if (options.allowRelatedDirect === true && directRelated.length > 0) {
    return {
      alias: directText,
      source: 'relation',
      sha256: directRelated[0].sha256,
      sha256s: [...new Set(directRelated.map((entry) => entry.sha256))],
      bindings: directRelated,
      matchedKeyword: directText,
      matchType: 'tag-relation',
    };
  }
  return null;
}

export function matchLongtuContextAlias(content, bindings = [], options = {}) {
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
    .find(([alias]) => containsLongtuTag(content, alias))?.[1];
  const related = matchRelatedLongtuTags(content, bindings, {
    ...options,
    allowHostile: options.allowHostile !== false,
  });
  if (!match && related.length === 0) return null;
  const merged = new Map();
  for (const binding of [...(match?.bindings ?? []), ...related]) {
    if (binding?.sha256 && !merged.has(binding.sha256)) merged.set(binding.sha256, binding);
  }
  return {
    ...(match ?? {
      alias: related[0].matchedKeyword || text,
      source: 'relation',
      bindings: related,
    }),
    sha256s: [...merged.keys()],
    bindings: [...merged.values()],
    sha256: [...merged.keys()][0],
    ...(related.length > 0 ? {
      matchedKeyword: related[0].matchedKeyword || match?.alias || text,
      matchType: 'tag-relation',
    } : {}),
  };
}

/**
 * 根据用户原话和模型刚生成的文案，寻找最可能对应的图库文字标签。
 * 这是本地字符串匹配，不调用模型，也不会改变“发张龙图”的随机路径。
 */
export function matchLongtuSceneAliases(content, answer, bindings = [], options = {}) {
  const contentText = longtuTagInput(content);
  const answerText = longtuTagInput(answer);
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
      || binding.deletedAt || binding.deleted_at || binding.blocked
    ) return [];
    return [{ binding, alias, normalizedAlias }];
  });

  const uniqueBySha = (entries) => [...new Map(entries.map((entry) => (
    [entry.binding.sha256, entry]
  ))).values()];

  const relationMatches = matchRelatedLongtuTags(
    [contentText, answerText].filter(Boolean).join('\n'),
    bindings,
    { ...options, allowHostile: options.allowHostile !== false },
  );

  // 管理员手动标记仍然是最高优先级的精确关系。
  const manualMatches = prepared
    .filter((entry) => (
      entry.binding.source === 'manual'
      && (containsLongtuTag(contentText, entry.alias)
        || containsLongtuTag(answerText, entry.alias))
    ))
    .sort((left, right) => right.normalizedAlias.length - left.normalizedAlias.length);
  const semanticPool = new Map();
  for (const entry of [
    ...manualMatches.map((entry) => ({ ...entry.binding, matchedKeyword: entry.alias })),
    ...relationMatches,
  ]) {
    if (!semanticPool.has(entry.sha256)) semanticPool.set(entry.sha256, entry);
  }

  const findKeywordPool = (input, minimumTermLength, rawInput) => {
    const boundedInput = input.slice(0, 160);
    const terms = new Set();
    const maximumTermLength = Math.min(6, boundedInput.length);
    for (let length = minimumTermLength; length <= maximumTermLength; length += 1) {
      for (let start = 0; start + length <= boundedInput.length; start += 1) {
        const term = boundedInput.slice(start, start + length);
        if (SCENE_ALIAS_STOPWORDS.has(term) || RESERVED_ALIASES.has(term)) continue;
        if (/^[a-z0-9]+$/u.test(term) && !containsLongtuTag(rawInput, term)) continue;
        terms.add(term);
      }
    }

    const pools = [];
    for (const term of terms) {
      const matches = uniqueBySha(prepared.filter((entry) => (
        entry.binding.source === 'ocr'
        && entry.normalizedAlias.includes(term)
        && (!/^[a-z0-9]+$/u.test(term) || containsLongtuTag(entry.alias, term))
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
  const contentPool = findKeywordPool(normalizedContent, 2, contentText);
  for (const entry of contentPool) {
    if (!semanticPool.has(entry.sha256)) semanticPool.set(entry.sha256, entry);
  }
  if (semanticPool.size > 0) return [...semanticPool.values()];
  const answerPool = findKeywordPool(normalizedAnswer, 3, answerText);
  if (answerPool.length > 0) return answerPool;

  const usefulOverlapLength = (overlap, text, alias) => (
    overlap.length >= 2 && !SCENE_ALIAS_STOPWORDS.has(overlap)
      && (!/^[a-z0-9]+$/u.test(overlap)
        || (containsLongtuTag(text, overlap) && containsLongtuTag(alias, overlap)))
      ? overlap.length
      : 0
  );
  const scored = [];
  for (const { binding, alias, normalizedAlias } of prepared) {
    const contentOverlap = longestCommonSubstring(normalizedContent, normalizedAlias);
    const answerOverlap = longestCommonSubstring(normalizedAnswer, normalizedAlias);
    const contentOverlapLength = usefulOverlapLength(contentOverlap, contentText, alias);
    const answerOverlapLength = usefulOverlapLength(answerOverlap, answerText, alias);
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

  return uniqueBySha(scored.filter((entry) => entry.score >= Math.max(best.score - 20, best.score * 0.8)))
    .map((entry) => ({ ...entry.binding, matchedKeyword: entry.alias }));
}

export function matchLongtuSceneAlias(content, answer, bindings = [], options = {}) {
  return matchLongtuSceneAliases(content, answer, bindings, options)[0] ?? null;
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
