// Recurring NYSE/Nasdaq equity holidays and shortened extended sessions.
// https://www.nyse.com/trade/hours-calendars
// Exceptional exchange closures can be added here without changing scheduling.
const exceptionalClosures = new Set(["2025-01-09"]);
const calendars = new Map<number, Set<string>>();
const dayMs = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const dateAt = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));

function weekdayInMonth(year: number, month: number, weekday: number, occurrence: number) {
  const first = dateAt(year, month, 1);
  return dateAt(year, month, 1 + (weekday - first.getUTCDay() + 7) % 7 + 7 * (occurrence - 1));
}

function observed(year: number, month: number, day: number) {
  const date = dateAt(year, month, day);
  const weekday = date.getUTCDay();
  return iso(new Date(date.getTime() + (weekday === 6 ? -1 : weekday === 0 ? 1 : 0) * dayMs));
}

function goodFriday(year: number) {
  // Gregorian Easter (Meeus/Jones/Butcher), followed by the preceding Friday.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return iso(dateAt(year, month, day - 2));
}

function holidays(year: number) {
  let dates = calendars.get(year);
  if (dates) return dates;
  const memorial = dateAt(year, 5, 31);
  memorial.setUTCDate(31 - (memorial.getUTCDay() + 6) % 7);
  dates = new Set([
    // A Saturday New Year's Day does not close the preceding Friday.
    dateAt(year, 1, 1).getUTCDay() === 6 ? `${year}-01-01` : observed(year, 1, 1),
    iso(weekdayInMonth(year, 1, 1, 3)), iso(weekdayInMonth(year, 2, 1, 3)),
    goodFriday(year), iso(memorial), observed(year, 7, 4),
    iso(weekdayInMonth(year, 9, 1, 1)), iso(weekdayInMonth(year, 11, 4, 4)),
    observed(year, 12, 25),
    ...(year >= 2022 ? [observed(year, 6, 19)] : []),
  ]);
  calendars.set(year, dates);
  return dates;
}

export function usEquitySession(date: string): { openHour: number; closeHour: number } | null {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  const weekday = parsed.getUTCDay(), year = parsed.getUTCFullYear();
  if (weekday === 0 || weekday === 6 || holidays(year).has(date) || exceptionalClosures.has(date)) return null;
  const thanksgiving = weekdayInMonth(year, 11, 4, 4);
  const afterThanksgiving = iso(new Date(thanksgiving.getTime() + dayMs));
  const earlyClose = date === afterThanksgiving || date === `${year}-12-24` || date === `${year}-07-03`;
  return { openHour: 4, closeHour: earlyClose ? 17 : 20 };
}
