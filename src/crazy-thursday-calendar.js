const DAY_MS = 86_400_000;
const FIXED_HOLIDAYS = new Map([
  ['元旦', '1-1'], ['情人节', '2-14'], ['妇女节', '3-8'],
  ['劳动节', '5-1'], ['五一', '5-1'], ['儿童节', '6-1'], ['六一', '6-1'],
  ['六一儿童节', '6-1'], ['教师节', '9-10'], ['国庆', '10-1'], ['国庆节', '10-1'],
  ['万圣节', '10-31'], ['双十一', '11-11'], ['平安夜', '12-24'], ['圣诞节', '12-25'],
]);
const HOLIDAY = '六一儿童节|国庆节|圣诞节|情人节|劳动节|儿童节|妇女节|教师节|万圣节|平安夜|双十一|元旦|五一|六一|国庆|七夕|中秋节?|端午节?|春节|除夕|元宵节?|清明节?|跨年|新年';

function chineseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  const normalized = value.replace(/〇/gu, '零').replace(/两/gu, '二');
  if (normalized.includes('十')) {
    const [tens, units] = normalized.split('十');
    return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
  }
  return Number([...normalized].map((digit) => digits.indexOf(digit)).join(''));
}

// Return a reason for rejecting an original, or '' when it can be drawn today.
// This checks preconditions, never rewrites them into a new story. Unverifiable
// dated events stay out of the everyday pool instead of guessing a new date.
export function crazyThursdayCalendarRejection(original, date) {
  const current = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(current.getTime())
    || current.toISOString().slice(0, 10) !== date) return 'invalid-date';
  const text = String(original).replace(/\s+/gu, '').toLowerCase();
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth() + 1;
  const day = current.getUTCDate();
  const dayOfYear = Math.floor((current - Date.UTC(year, 0, 1)) / DAY_MS) + 1;

  const ordinals = [...text.matchAll(/(最后一|第[\d一二三四五六七八九十两]+)[次个回](?:(?:kfc|肯德基|的|疯狂))*(?:星期四|期星四|周四)/gu)];
  if (ordinals.length) {
    const scopes = ordinals.flatMap((match) => [...text.slice(Math.max(0, match.index - 20), match.index)
      .matchAll(/((?:19|20)\d{2}|二[〇零一二三四五六七八九]{3})年|2k(\d{2})|今年|本年|全年|年度|年内|本月|这个月/gu)]);
    if (!scopes.length) return 'unknown-calendar-period';
    const monthly = scopes.some((match) => /本月|这个月/u.test(match[0]));
    if (monthly && scopes.some((match) => !/本月|这个月/u.test(match[0]))) return 'ambiguous-calendar-period';
    for (const scope of scopes) {
      const explicitYear = scope[1] ? chineseNumber(scope[1]) : (scope[2] ? 2000 + Number(scope[2]) : null);
      if (explicitYear !== null && explicitYear !== year) return 'wrong-year';
    }
    if (current.getUTCDay() !== 4) return 'not-thursday';
    const ordinal = Math.floor(((monthly ? day : dayOfYear) - 1) / 7) + 1;
    const nextWeek = new Date(current.getTime() + 7 * DAY_MS);
    const last = monthly ? nextWeek.getUTCMonth() !== current.getUTCMonth() : nextWeek.getUTCFullYear() !== year;
    for (const match of ordinals) {
      if (match[1] === '最后一' ? !last : chineseNumber(match[1].slice(1)) !== ordinal) return 'wrong-thursday-ordinal';
    }
    // Some years have 53 Thursdays; don't reuse a quote claiming "前 51 个"
    // on that year's 53rd Thursday, even if the year and "last" both match.
    const previous = /前([\d一二三四五六七八九十两]+)个(?:你们|大家|星期四|周四)/u.exec(text);
    if (previous && chineseNumber(previous[1]) !== ordinal - 1) return 'wrong-thursday-count';
  }

  if (/(?:本月|这个月)[^。！？；]{0,16}最后一天/u.test(text)
    && new Date(current.getTime() + DAY_MS).getUTCMonth() === current.getUTCMonth()) return 'not-month-end';
  if (/(?:今年|本年)[^。！？；]{0,16}最后一天/u.test(text) && (month !== 12 || day !== 31)) return 'not-year-end';
  const yearDay = /今年[^。！？；]{0,16}第(\d+)天/u.exec(text);
  if (yearDay && Number(yearDay[1]) !== dayOfYear) return 'wrong-day-of-year';

  // Full dates after 今天/今日/现在 are handled by the date adapter. A bare
  // "今天是 2024 年" has no such adapter and must not leak an obsolete year.
  const currentYear = /(?:今天|今日|现在)(?:是)?((?:19|20)\d{2})年(?![\d一二三四五六七八九十]+月)/u.exec(text);
  if (currentYear && Number(currentYear[1]) !== year) return 'wrong-year';

  const holidayText = text.replace(/(今天|今日|现在)(?:是)?(?:(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]|(?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2})/gu, '$1');
  const holidayStatements = holidayText.matchAll(new RegExp(`(今天|今日|现在|明天|明日|昨天|昨日|后天|前天)[，,]?(?:就是|正是|也是|是|过|又到|迎来|到了|恰逢)?(${HOLIDAY})`, 'gu'));
  const offsets = { 今天: 0, 今日: 0, 现在: 0, 明天: 1, 明日: 1, 昨天: -1, 昨日: -1, 后天: 2, 前天: -2 };
  for (const match of holidayStatements) {
    const expected = FIXED_HOLIDAYS.get(match[2]);
    if (!expected) return 'unverified-holiday';
    const target = new Date(current.getTime() + offsets[match[1]] * DAY_MS);
    if (`${target.getUTCMonth() + 1}-${target.getUTCDate()}` !== expected) return 'wrong-holiday';
  }
  if (new RegExp(`(?:过几天|再过[\d一二三四五六七八九十]+天|快要|马上|刚过|即将|临近|距离)[^。！？；]{0,12}(?:${HOLIDAY})|(?:${HOLIDAY})(?:还有|刚过|刚结束|假期|快乐)`, 'u').test(text)
    || /调休|节后返工|假期结束|假期最后一天/u.test(text)) return 'unverified-holiday-window';

  const hasFixedDate = /(?:\d{1,2}|[一二三四五六七八九十]{1,3})月(?:\d{1,2}|[一二三四五六七八九十]{1,3})[日号]|(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/u.test(text);
  if (hasFixedDate && /定于|婚期|邀请函|查出|招聘|报送时间|收录时间|更新时间|将于|请于|检测通知/u.test(text)) return 'dated-event';
  if (/(?:农历|腊月|正月)[^。！？；]{0,20}(?:星期四|周四|随礼)/u.test(text)) return 'unverified-lunar-date';
  if (/(?:现在|此刻)(?:是)?(?:上午|下午|晚上|凌晨)?[\d一二三四五六七八九十]+[点时:：]/u.test(text)) return 'fixed-clock-time';

  const seasonMonths = { 春: [3, 4, 5], 夏: [6, 7, 8], 秋: [9, 10, 11], 冬: [12, 1, 2] };
  for (const [season, months] of Object.entries(seasonMonths)) {
    const assertion = new RegExp(`${season}(?:天|季)(?:已经|已|悄悄|终于|到了|来了|来临了)|(?:这个|现在是|如今是|即将来临的)${season}(?:天|季)`, 'u');
    if (assertion.test(text) && !months.includes(month)) return 'wrong-season';
  }
  return '';
}
