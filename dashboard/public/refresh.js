// When to auto-refresh: often during NFL game windows, rarely otherwise.
// Times are US Eastern, where the NFL schedules its games.

export const LIVE_INTERVAL_MS = 2 * 60 * 1000;
export const IDLE_INTERVAL_MS = 15 * 60 * 1000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday (0 = Sunday), hour (0-23) and month (1-12) in US Eastern time. */
export function easternParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
    month: "numeric",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: WEEKDAYS.indexOf(get("weekday")),
    hour: Number(get("hour")) % 24,
    month: Number(get("month")),
  };
}

/**
 * True during typical NFL game windows (Eastern):
 *  - Thursday night: Thu 19:00 - Fri 01:00
 *  - Sunday: 09:00 (London games) - Mon 01:00
 *  - Monday night: Mon 19:00 - Tue 01:00
 *  - Saturdays from mid-December into January: 12:00 - 24:00
 *  - Friday nights in September (season-opening international game)
 */
export function isGameWindow(date = new Date()) {
  const { weekday, hour, month } = easternParts(date);
  const lateNight = hour < 1;
  switch (weekday) {
    case 4: // Thu
      return hour >= 19;
    case 5: // Fri
      return lateNight || (month === 9 && hour >= 19);
    case 6: // Sat
      return (month === 12 || month === 1) && hour >= 12;
    case 0: // Sun
      return hour >= 9;
    case 1: // Mon
      return lateNight || hour >= 19;
    case 2: // Tue
      return lateNight;
    default:
      return false;
  }
}

export function refreshInterval(date = new Date()) {
  return isGameWindow(date) ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
}
