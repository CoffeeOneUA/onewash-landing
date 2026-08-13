const { sbSelect } = require('./supabase');
const { LOCATION_ID, TIMEZONE, SLOT_STEP_MINUTES } = require('./domain');

// IMPORTANT / UNVERIFIED ASSUMPTION:
// `weekday` in location_working_hours / staff_schedule is assumed to be ISO
// convention 1=Monday..7=Sunday (Postgres extract(isodow)). If your data
// actually uses 0=Sunday..6=Saturday, flip WEEKDAY_ISO to false below.
const WEEKDAY_ISO = true;

function weekdayForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  if (!WEEKDAY_ISO) return utcDay;
  return utcDay === 0 ? 7 : utcDay; // 1=Mon..7=Sun
}

function hmsToMinutes(hms) {
  const [h, m] = hms.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHm(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function kyivPartsNow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function kyivDateOf(isoTimestamp) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(isoTimestamp)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * Returns [{ time: 'HH:MM', staffIds: [uuid, ...] }] for the given date + service duration.
 */
async function getAvailableSlots(date, durationMinutes) {
  const weekday = weekdayForDate(date);

  const hours = await sbSelect('location_working_hours', {
    select: 'is_open,open_time,close_time',
    location_id: `eq.${LOCATION_ID}`,
    weekday: `eq.${weekday}`,
  });
  const wh = hours[0];
  if (!wh || wh.is_open === false) return [];

  const openMin = hmsToMinutes(wh.open_time);
  const closeMin = hmsToMinutes(wh.close_time);

  const staff = await sbSelect('staff', {
    select: 'id',
    location_id: `eq.${LOCATION_ID}`,
    is_active: 'eq.true',
  });
  if (!staff.length) return [];
  const staffIds = staff.map((s) => s.id);

  const dateOverrides = await sbSelect('staff_schedule_dates', {
    select: 'staff_id,is_working',
    staff_id: `in.(${staffIds.join(',')})`,
    work_date: `eq.${date}`,
  });
  const overrideMap = new Map(dateOverrides.map((r) => [r.staff_id, r.is_working]));

  const weeklySchedule = await sbSelect('staff_schedule', {
    select: 'staff_id,is_working',
    staff_id: `in.(${staffIds.join(',')})`,
    weekday: `eq.${weekday}`,
  });
  const weeklyMap = new Map(weeklySchedule.map((r) => [r.staff_id, r.is_working]));

  const workingStaffIds = staffIds.filter((id) => {
    if (overrideMap.has(id)) return overrideMap.get(id) === true;
    if (weeklyMap.has(id)) return weeklyMap.get(id) === true;
    return false; // no schedule row at all => treat as not scheduled that day
  });
  if (!workingStaffIds.length) return [];

  // Wide UTC net around the target date, filtered precisely below by Kyiv wall-clock date.
  const dayBefore = new Date(`${date}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const dayAfter = new Date(`${date}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 2);

  const existing = await sbSelect('bookings', {
    select: 'staff_id,scheduled_at,scheduled_end',
    staff_id: `in.(${workingStaffIds.join(',')})`,
    scheduled_at: `gte.${dayBefore.toISOString()}`,
    status: 'neq.cancelled',
  });

  const busyByStaff = new Map(workingStaffIds.map((id) => [id, []]));
  for (const b of existing) {
    if (!b.scheduled_end) continue;
    const start = kyivDateOf(b.scheduled_at);
    if (start.date !== date) continue;
    const end = kyivDateOf(b.scheduled_end);
    const endMinutes = end.date === date ? end.minutes : 24 * 60;
    const arr = busyByStaff.get(b.staff_id);
    if (arr) arr.push([start.minutes, endMinutes]);
  }

  const now = kyivPartsNow();
  const isToday = now.date === date;
  const slots = [];

  for (let t = openMin; t + durationMinutes <= closeMin; t += SLOT_STEP_MINUTES) {
    if (isToday && t <= now.minutes + 30) continue; // need at least 30 min notice
    const free = workingStaffIds.filter((id) => {
      const busy = busyByStaff.get(id) || [];
      return !busy.some(([bStart, bEnd]) => bStart < t + durationMinutes && bEnd > t);
    });
    if (free.length) slots.push({ time: minutesToHm(t), staffIds: free });
  }

  return slots;
}

/** Converts a Europe/Kyiv wall-clock date+time ("YYYY-MM-DD", "HH:MM") to a UTC ISO instant. */
function kyivWallToUtcIso(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const got = kyivDateOf(new Date(guess).toISOString());
    const gotMinutesTotal = got.minutes + (got.date === date ? 0 : (got.date < date ? 1440 : -1440));
    const wantMinutesTotal = hh * 60 + mm;
    const diff = wantMinutesTotal - gotMinutesTotal;
    if (diff === 0) break;
    guess += diff * 60000;
  }
  return new Date(guess).toISOString();
}

module.exports = { getAvailableSlots, weekdayForDate, kyivPartsNow, kyivDateOf, kyivWallToUtcIso, TIMEZONE };
