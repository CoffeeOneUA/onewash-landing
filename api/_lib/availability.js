const { sbSelect } = require('./supabase');
const { LOCATION_ID, TIMEZONE, SLOT_STEP_MINUTES, WASH_TYPES } = require('./domain');

// How long a 'pending' payment_links row holds its slot for. Covers the window between
// "customer clicked pay" and "webhook/active-check confirms it" — without this, an admin
// could book the same staff/box out from under a customer who is mid-checkout on WayForPay.
const PENDING_HOLD_MINUTES = 20;

const WASH_TYPE_DURATION_BY_ID = Object.fromEntries(Object.values(WASH_TYPES).map((w) => [w.id, w.duration]));

function pendingHoldDurationMinutes(link) {
  const base = WASH_TYPE_DURATION_BY_ID[link.wash_type_id] || 60;
  const extras = Array.isArray(link.extras) ? link.extras : [];
  return base + extras.reduce((s, e) => s + Number(e.duration_minutes || 0), 0);
}

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
 * Returns [{ time: 'HH:MM', staffIds: [uuid, ...], boxIds: [uuid, ...] | null }]
 * for the given date + service duration. `boxIds` is null when the location
 * has no wash_boxes configured at all (nothing to constrain against, same
 * convention the admin panel uses when no box is picked).
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

  const [staff, boxes] = await Promise.all([
    sbSelect('staff', { select: 'id', location_id: `eq.${LOCATION_ID}`, is_active: 'eq.true' }),
    sbSelect('wash_boxes', { select: '*', location_id: `eq.${LOCATION_ID}` }),
  ]);
  if (!staff.length) return [];
  const staffIds = staff.map((s) => s.id);

  // is_active may not exist yet on wash_boxes (pre-migration) — treat missing as active,
  // same fallback convention the admin panel uses.
  const activeBoxIds = boxes.filter((b) => b.is_active !== false).map((b) => b.id);
  const boxesConfigured = boxes.length > 0;

  const [dateOverrides, weeklySchedule] = await Promise.all([
    sbSelect('staff_schedule_dates', {
      select: 'staff_id,is_working',
      staff_id: `in.(${staffIds.join(',')})`,
      work_date: `eq.${date}`,
    }),
    sbSelect('staff_schedule', {
      select: 'staff_id,is_working',
      staff_id: `in.(${staffIds.join(',')})`,
      weekday: `eq.${weekday}`,
    }),
  ]);
  const overrideMap = new Map(dateOverrides.map((r) => [r.staff_id, r.is_working]));
  const weeklyMap = new Map(weeklySchedule.map((r) => [r.staff_id, r.is_working]));

  const workingStaffIds = staffIds.filter((id) => {
    if (overrideMap.has(id)) return overrideMap.get(id) === true;
    if (weeklyMap.has(id)) return weeklyMap.get(id) === true;
    return false; // no schedule row at all => treat as not scheduled that day
  });
  if (!workingStaffIds.length) return [];
  if (boxesConfigured && !activeBoxIds.length) return []; // boxes exist but all are switched off

  // Wide UTC net around the target date, filtered precisely below by Kyiv wall-clock date.
  // Fetched by location (not just staff_id) because a box can be occupied by a booking
  // assigned to staff outside today's working set too (edge case, but safer to include).
  const dayBefore = new Date(`${date}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);

  const pendingCutoff = new Date(Date.now() - PENDING_HOLD_MINUTES * 60000).toISOString();
  const [existing, pendingHolds] = await Promise.all([
    sbSelect('bookings', {
      select: 'staff_id,box_id,scheduled_at,scheduled_end',
      location_id: `eq.${LOCATION_ID}`,
      scheduled_at: `gte.${dayBefore.toISOString()}`,
      status: 'neq.cancelled',
    }),
    // Recent unpaid checkouts still in progress — held as soft busy intervals so an admin
    // can't double-book a slot while a customer is mid-payment on WayForPay (see PENDING_HOLD_MINUTES).
    sbSelect('payment_links', {
      select: 'staff_id,box_id,scheduled_at,wash_type_id,extras',
      location_id: `eq.${LOCATION_ID}`,
      status: 'eq.pending',
      created_at: `gte.${pendingCutoff}`,
      scheduled_at: `gte.${dayBefore.toISOString()}`,
    }),
  ]);

  const busyByStaff = new Map(workingStaffIds.map((id) => [id, []]));
  const busyByBox = new Map(activeBoxIds.map((id) => [id, []]));
  for (const b of existing) {
    if (!b.scheduled_end) continue;
    const start = kyivDateOf(b.scheduled_at);
    if (start.date !== date) continue;
    const end = kyivDateOf(b.scheduled_end);
    const endMinutes = end.date === date ? end.minutes : 24 * 60;
    const interval = [start.minutes, endMinutes];
    const staffArr = busyByStaff.get(b.staff_id);
    if (staffArr) staffArr.push(interval);
    const boxArr = b.box_id ? busyByBox.get(b.box_id) : null;
    if (boxArr) boxArr.push(interval);
  }
  for (const p of pendingHolds) {
    if (!p.scheduled_at) continue;
    const start = kyivDateOf(p.scheduled_at);
    if (start.date !== date) continue;
    const interval = [start.minutes, start.minutes + pendingHoldDurationMinutes(p)];
    const staffArr = p.staff_id ? busyByStaff.get(p.staff_id) : null;
    if (staffArr) staffArr.push(interval);
    const boxArr = p.box_id ? busyByBox.get(p.box_id) : null;
    if (boxArr) boxArr.push(interval);
  }

  const now = kyivPartsNow();
  const isToday = now.date === date;
  const slots = [];

  for (let t = openMin; t + durationMinutes <= closeMin; t += SLOT_STEP_MINUTES) {
    if (isToday && t <= now.minutes + 30) continue; // need at least 30 min notice

    const freeStaff = workingStaffIds.filter((id) => {
      const busy = busyByStaff.get(id) || [];
      return !busy.some(([bStart, bEnd]) => bStart < t + durationMinutes && bEnd > t);
    });
    if (!freeStaff.length) continue;

    let freeBoxes = null;
    if (boxesConfigured) {
      freeBoxes = activeBoxIds.filter((id) => {
        const busy = busyByBox.get(id) || [];
        return !busy.some(([bStart, bEnd]) => bStart < t + durationMinutes && bEnd > t);
      });
      if (!freeBoxes.length) continue; // staff free, but no box free — can't offer this slot
    }

    slots.push({ time: minutesToHm(t), staffIds: freeStaff, boxIds: freeBoxes });
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
