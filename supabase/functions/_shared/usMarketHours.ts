// تقويم جلسات السوق الأمريكي (NYSE / NASDAQ) بتوقيت America/New_York.
// المصدر المعتمد لساعات المحاكي: قبل التداول، الجلسة الرسمية، بعد التداول،
// مع وقوف تام في عطل نهاية الأسبوع والإجازات الرسمية وأيام الإغلاق المبكر.

export type UsMarketSession =
  | "premarket"
  | "regular"
  | "afterhours"
  | "weekend"
  | "holiday"
  | "overnight";

export interface NyStamp {
  weekday: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  minutes: number;
  ymd: string;
}

export interface UsMarketClock {
  tradable: boolean;
  session: UsMarketSession;
  earlyClose: boolean;
  holidayName: string | null;
  labelAr: string;
  ny: NyStamp;
}

const TZ = "America/New_York";
const PREMARKET_START = 4 * 60;
const REGULAR_START = 9 * 60 + 30;
const REGULAR_END = 16 * 60;
const AFTER_END = 20 * 60;
const EARLY_REGULAR_END = 13 * 60;
const EARLY_AFTER_END = 17 * 60;

interface YmdParts {
  year: number;
  month: number;
  day: number;
}

interface NyseYearCalendar {
  holidays: Map<string, string>;
  earlyCloses: Set<string>;
}

const calendarCache = new Map<number, NyseYearCalendar>();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function ymdKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function fromUtcDate(dt: Date): YmdParts {
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function easterSunday(year: number): YmdParts {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function nthWeekday(year: number, month: number, weekday: number, n: number): YmdParts {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7;
  return { year, month, day };
}

function lastWeekday(year: number, month: number, weekday: number): YmdParts {
  const last = new Date(Date.UTC(year, month, 0));
  const day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return { year, month, day };
}

function observed(year: number, month: number, day: number): YmdParts {
  const dt = new Date(Date.UTC(year, month - 1, day));
  const wd = dt.getUTCDay();
  if (wd === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  else if (wd === 0) dt.setUTCDate(dt.getUTCDate() + 1);
  return fromUtcDate(dt);
}

function shiftDays(parts: YmdParts, delta: number): YmdParts {
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta));
  return fromUtcDate(dt);
}

export function nyseCalendar(year: number): NyseYearCalendar {
  const cached = calendarCache.get(year);
  if (cached) return cached;
  const holidays = new Map<string, string>();
  const add = (parts: YmdParts, name: string) =>
    holidays.set(ymdKey(parts.year, parts.month, parts.day), name);

  add(observed(year, 1, 1), "رأس السنة الميلادية");
  add(nthWeekday(year, 1, 1, 3), "يوم مارتن لوثر كينغ الابن");
  add(nthWeekday(year, 2, 1, 3), "يوم الرؤساء");
  add(shiftDays(easterSunday(year), -2), "الجمعة العظيمة");
  add(lastWeekday(year, 5, 1), "يوم الذكرى");
  add(observed(year, 6, 19), "يوم جونتينث");
  add(observed(year, 7, 4), "يوم الاستقلال");
  add(nthWeekday(year, 9, 1, 1), "عيد العمال");
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  add(thanksgiving, "عيد الشكر");
  add(observed(year, 12, 25), "عيد الميلاد");

  const earlyCloses = new Set<string>();
  const addEarly = (parts: YmdParts) => {
    const key = ymdKey(parts.year, parts.month, parts.day);
    if (!holidays.has(key)) earlyCloses.add(key);
  };
  addEarly(shiftDays(thanksgiving, 1));
  const eveWd = new Date(Date.UTC(year, 11, 24)).getUTCDay();
  if (eveWd !== 0 && eveWd !== 6) addEarly({ year, month: 12, day: 24 });
  const jul3Wd = new Date(Date.UTC(year, 6, 3)).getUTCDay();
  if (jul3Wd !== 0 && jul3Wd !== 6) addEarly({ year, month: 7, day: 3 });
  if (new Date(Date.UTC(year, 6, 4)).getUTCDay() === 0) addEarly({ year, month: 7, day: 2 });

  const result = { holidays, earlyCloses };
  calendarCache.set(year, result);
  return result;
}

function lookupHoliday(ymd: string, year: number): string | null {
  for (const y of [year - 1, year, year + 1]) {
    const name = nyseCalendar(y).holidays.get(ymd);
    if (name) return name;
  }
  return null;
}

function lookupEarlyClose(ymd: string, year: number): boolean {
  for (const y of [year - 1, year, year + 1]) {
    if (nyseCalendar(y).earlyCloses.has(ymd)) return true;
  }
  return false;
}

function nyParts(date: Date): NyStamp {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const minute = Number(map.minute);
  return {
    weekday: map.weekday,
    year,
    month,
    day,
    hour,
    minute,
    minutes: hour * 60 + minute,
    ymd: ymdKey(year, month, day),
  };
}

export function getUsMarketClock(date: Date = new Date()): UsMarketClock {
  const ny = nyParts(date);
  const weekend = ny.weekday === "Sat" || ny.weekday === "Sun";
  const holidayName = weekend ? null : lookupHoliday(ny.ymd, ny.year);
  const earlyClose = !weekend && !holidayName && lookupEarlyClose(ny.ymd, ny.year);
  const regularEnd = earlyClose ? EARLY_REGULAR_END : REGULAR_END;
  const afterEnd = earlyClose ? EARLY_AFTER_END : AFTER_END;

  let session: UsMarketSession = "overnight";
  let tradable = false;
  let labelAr = "خارج ساعات التداول الممتدة (بعد الإغلاق أو قبل 04:00 بتوقيت نيويورك)";

  if (weekend) {
    session = "weekend";
    labelAr = "عطلة نهاية الأسبوع — السوق الأمريكي متوقف تماماً";
  } else if (holidayName) {
    session = "holiday";
    labelAr = `إجازة رسمية في السوق الأمريكي: ${holidayName} — وقوف تام`;
  } else if (ny.minutes >= PREMARKET_START && ny.minutes < REGULAR_START) {
    session = "premarket";
    tradable = true;
    labelAr = "جلسة ما قبل التداول (04:00–09:30 بتوقيت نيويورك)";
  } else if (ny.minutes >= REGULAR_START && ny.minutes < regularEnd) {
    session = "regular";
    tradable = true;
    labelAr = earlyClose
      ? "الجلسة الرسمية — إغلاق مبكر حتى 13:00 بتوقيت نيويورك"
      : "الجلسة الرسمية (09:30–16:00 بتوقيت نيويورك)";
  } else if (ny.minutes >= regularEnd && ny.minutes < afterEnd) {
    session = "afterhours";
    tradable = true;
    labelAr = earlyClose
      ? "جلسة ما بعد التداول — إغلاق مبكر (13:00–17:00 بتوقيت نيويورك)"
      : "جلسة ما بعد التداول (16:00–20:00 بتوقيت نيويورك)";
  }

  return { tradable, session, earlyClose, holidayName, labelAr, ny };
}
