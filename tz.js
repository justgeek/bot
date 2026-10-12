// tz.js - timezone & rollover helpers shared by stats.js, report.js, and dashboard.js.
const HOUR = 3600e3;
const DEFAULT_TZ = "Africa/Cairo";
const helpers = new Map();
const pad = (n) => String(n).padStart(2, "0");

function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function makeTz(input, dayStartHour = 0) {
  const tz = validTz(input) || DEFAULT_TZ;
  const H = Math.min(23, Math.max(0, parseInt(dayStartHour, 10) || 0));
  const cacheKey = `${tz}:${H}`;
  const cached = helpers.get(cacheKey);
  if (cached) return cached;

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offCache = new Map();
  const dayCache = new Map();
  const binCache = new Map();

  function offset(ms) {
    const k = Math.floor(ms / 900000);
    let o = offCache.get(k);
    if (o === undefined) {
      const t = k * 900000;
      const p = {};
      for (const x of fmt.formatToParts(t)) p[x.type] = x.value;
      o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
      if (offCache.size > 100000) offCache.clear();
      offCache.set(k, o);
    }
    return o;
  }

  const dateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  // Date on the viewer's clock, adjusted by the gaming day rollover hour H
  function dateOf(ms) {
    return dateStr(new Date(ms + offset(ms) - H * HOUR));
  }

  function partsOf(ms) {
    const dShifted = new Date(ms + offset(ms) - H * HOUR);
    const dLocal = new Date(ms + offset(ms));
    return {
      date: dateStr(dShifted),
      hour: dLocal.getUTCHours(),
      minute: dLocal.getUTCMinutes(),
      dow: (dShifted.getUTCDay() + 6) % 7
    };
  }

  function addDays(date, n) {
    const [y, m, d] = date.split("-").map(Number);
    return dateStr(new Date(Date.UTC(y, m - 1, d + n)));
  }

  function startOfDate(date) {
    const [y, m, d] = date.split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d);
    let t = guess - offset(guess);
    t = guess - offset(t);
    // Offset local midnight by H hours so gaming days start at H:00
    return t + H * HOUR;
  }

  function localToMs(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(str || ""));
    if (!m) return NaN;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return NaN;
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let t = guess - offset(guess);
    t = guess - offset(t);
    return t;
  }

  function dayBounds(date) {
    let b = dayCache.get(date);
    if (!b) {
      b = [startOfDate(date), startOfDate(addDays(date, 1))];
      if (dayCache.size > 5000) dayCache.clear();
      dayCache.set(date, b);
    }
    return b;
  }

  function binOfLocal(localHourStart) {
    let b = binCache.get(localHourStart);
    if (!b) {
      const d = new Date(localHourStart);
      const dShifted = new Date(localHourStart - H * HOUR);
      b = {
        hour: d.getUTCHours(),
        dow: (dShifted.getUTCDay() + 6) % 7,
        date: dateStr(dShifted)
      };
      if (binCache.size > 200000) binCache.clear();
      binCache.set(localHourStart, b);
    }
    return b;
  }

  function eachHourSlice(start, end, cb) {
    let t = start;
    while (t < end) {
      const local = t + offset(t);
      const hourStartLocal = Math.floor(local / HOUR) * HOUR;
      const next = Math.min(t + (hourStartLocal + HOUR - local), end);
      cb(binOfLocal(hourStartLocal), (next - t) / 1000, t, next);
      t = next;
    }
  }

  const helper = { tz, dayStartHour: H, offset, dateOf, partsOf, addDays, startOfDate, localToMs, dayBounds, eachHourSlice };
  helpers.set(cacheKey, helper);
  return helper;
}

module.exports = { makeTz, validTz, DEFAULT_TZ };