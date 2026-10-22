const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_MAX_CHARACTERS = 1_200;
const WORD_NUMBER = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const RELATIVE_DATE_PATTERN = /(?:再过|再|过)?\s*([0-9]+|[一二两三四五六七八九十]+|半)\s*(天|日|周|星期|个?月|年)\s*(?:之?后|以后|后)?/gu;

function shanghaiParts(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const shanghai = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shanghai.getUTCFullYear(),
    month: shanghai.getUTCMonth() + 1,
    day: shanghai.getUTCDate(),
  };
}

function parseAmount(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d+$/u.test(text)) return Number(text);
  if (text === '半') return 0.5;
  if (text === '十') return 10;
  if (text.length === 1) return WORD_NUMBER[text] ?? 0;
  if (text.startsWith('十')) {
    return 10 + (WORD_NUMBER[text.slice(1)] ?? 0);
  }
  if (text.endsWith('十') && text.length === 2) {
    return (WORD_NUMBER[text[0]] ?? 0) * 10;
  }
  if (text.includes('十')) {
    const [left, right] = text.split('十');
    return (WORD_NUMBER[left] ?? 0) * 10 + (WORD_NUMBER[right] ?? 0);
  }
  return 0;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addCalendarMonths(parts, months) {
  const wholeMonths = Math.trunc(months);
  const rawMonth = parts.month - 1 + wholeMonths;
  const year = parts.year + Math.floor(rawMonth / 12);
  const month = ((rawMonth % 12) + 12) % 12 + 1;
  return {
    year,
    month,
    day: Math.min(parts.day, daysInMonth(year, month)),
  };
}

function addCalendarYears(parts, years) {
  const wholeYears = Math.trunc(years);
  const year = parts.year + wholeYears;
  return {
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month)),
  };
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + Math.trunc(days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function normalizeUnit(unit) {
  const value = String(unit ?? '');
  if (value === '天' || value === '日') return 'day';
  if (value === '周' || value === '星期') return 'week';
  if (value === '月' || value === '个月') return 'month';
  if (value === '年') return 'year';
  return '';
}

function addAmount(parts, amount, unit) {
  if (unit === 'day') return addCalendarDays(parts, amount);
  if (unit === 'week') return addCalendarDays(parts, amount * 7);
  if (unit === 'month') return addCalendarMonths(parts, amount);
  if (unit === 'year') return addCalendarYears(parts, amount);
  return parts;
}

function formatDate(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function extractRelativeDateFacts(now = Date.now(), text = '') {
  const parts = shanghaiParts(now);
  const normalized = String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, DEFAULT_MAX_CHARACTERS);
  if (!parts || !normalized) return [];
  const facts = [];
  const seen = new Set();
  for (const match of normalized.matchAll(RELATIVE_DATE_PATTERN)) {
    const phrase = String(match[0] ?? '').trim();
    const amount = parseAmount(match[1]);
    const unit = normalizeUnit(match[2]);
    if (!phrase || amount <= 0 || !unit) continue;
    // Without a 后/以后 marker, “三个月” is often just a duration, not a
    // calendar prediction. Keep explicit “再过/过” forms and all 后 forms.
    if (!/(?:之?后|以后|后)$/u.test(phrase)
      && !/^(?:再过|再|过)/u.test(phrase)) continue;
    const target = addAmount(parts, amount, unit);
    const key = `${phrase}|${formatDate(target)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      phrase,
      amount,
      unit,
      sourceDate: formatDate(parts),
      targetDate: formatDate(target),
      targetYear: target.year,
      targetMonth: target.month,
    });
    if (facts.length >= 3) break;
  }
  return facts;
}

function formatFact(fact) {
  const monthText = `${fact.targetYear} 年 ${fact.targetMonth} 月`;
  return `${fact.phrase}对应 ${fact.targetDate}（${monthText}）`;
}

export function buildRelativeDatePrompt(now = Date.now(), text = '') {
  const facts = extractRelativeDateFacts(now, text);
  if (facts.length === 0) return '';
  const parts = shanghaiParts(now);
  return [
    '【程序计算的相对时间】',
    `当前北京时间日期：${parts ? formatDate(parts) : ''}。`,
    ...facts.map((fact) => `- ${formatFact(fact)}；目标年份是 ${fact.targetYear}。`),
    '这些结果是权威事实，优先级高于训练记忆、截图文字主张和模型心算。涉及“几天后”“几个月后”“跨年”“进入某年”时必须先按这里的事实判断；如果问题是在问该日期对应的现实活动、发售或新闻，必须以当前检索结果为准，图片里的旧日期只能作为历史线索，不能直接当成现在的事件。',
  ].join('\n');
}

function contradictionForFact(answer, fact) {
  const normalized = String(answer ?? '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return false;
  const year = String(fact.targetYear);
  const wrongYear = /(?:还|仍|依然|其实|根本|并|没|未|不)(?:在|是|到|进入)?\s*(20\d{2})\s*年?/u.exec(normalized);
  if (wrongYear && Number(wrongYear[1]) < fact.targetYear) return true;
  if (new RegExp(`(?:离|距|差(?:着|了)?).{0,12}${year}.{0,12}(?:差|还|两|俩|二|2|几).{0,6}(?:个)?月`, 'u').test(normalized)) {
    return true;
  }
  if (new RegExp(`(?:还没|没到|不到|不是|并非|根本不在|仍(?:在|是)|还(?:在|是)).{0,8}${year}`, 'u').test(normalized)) {
    return true;
  }
  if (new RegExp(`${year}.{0,12}(?:差|还差|没到|还没到|差着).{0,8}(?:两|俩|二|2|几|一|三|)个?月`, 'u').test(normalized)) {
    return true;
  }
  return false;
}

export function relativeDateContradiction(answer, facts = []) {
  const usable = Array.isArray(facts) ? facts.filter(Boolean) : [];
  if (usable.length === 0) return '';
  for (const fact of usable) {
    if (contradictionForFact(answer, fact)) return 'relative-date-contradiction';
  }
  return '';
}

export function buildRelativeDateCorrectionPrompt(facts = []) {
  const usable = Array.isArray(facts) ? facts.filter(Boolean) : [];
  if (usable.length === 0) return '';
  return [
    '【相对时间纠错】',
    ...usable.map((fact) => `程序已算定：${formatFact(fact)}，目标年份是 ${fact.targetYear}。`),
    '初稿把相对时间或年份算错了。保留正确的事实判断，删除“还在上一年”“差几个月”“不是目标年份”等错误说法。',
    '如果原内容本身是夸张玩梗，可以说明“日历字面没错，梗是在夸张”，但不得否定程序算出的年份。',
  ].join('\n');
}

export function repairRelativeDateAnswer(answer, facts = [], now = Date.now()) {
  const usable = Array.isArray(facts) ? facts.filter(Boolean) : [];
  if (usable.length === 0 || !relativeDateContradiction(answer, usable)) {
    return String(answer ?? '').trim();
  }
  const sentences = String(answer ?? '')
    .split(/(?<=[。！？!?；;\n])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !relativeDateContradiction(sentence, usable));
  const lead = usable.map((fact) => formatFact(fact)).join('；');
  return [`按北京时间 ${formatDate(shanghaiParts(now))} 算，${lead}。`, ...sentences]
    .filter(Boolean)
    .join('\n')
    .slice(0, 600)
    .trim();
}

