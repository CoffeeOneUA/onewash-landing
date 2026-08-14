const { sbSelect, sbInsert, sbUpdate } = require('./supabase');
const { LOCATION_ID, WASH_TYPES } = require('./domain');

const WASH_TYPE_DURATION_BY_ID = Object.fromEntries(Object.values(WASH_TYPES).map((w) => [w.id, w.duration]));

/**
 * Turns a paid payment_links row into a real booking (client/car find-or-create,
 * bookings + booking_extras insert, payment_links marked paid). Idempotent — safe
 * to call more than once for the same link (e.g. both the webhook AND the active
 * status check racing each other); only the first call does anything.
 *
 * Used by both the passive WayForPay webhook (wayforpay-callback.js) and the
 * active reconciliation check (order-status.js), so there's one place that
 * defines what "a site booking got paid" actually does.
 */
async function completePaidBooking(link, paidAmount) {
  // Idempotency: already processed by the other path.
  if (link.status === 'paid' && link.booking_id) {
    return { alreadyDone: true, bookingId: link.booking_id };
  }

  // ---- find or create the client (guest checkout — no app account) ----
  const existingClients = await sbSelect('clients', {
    select: 'id',
    location_id: `eq.${LOCATION_ID}`,
    phone: `eq.${link.client_phone}`,
    limit: '1',
  });
  let clientId = existingClients[0]?.id;
  if (!clientId) {
    const newClient = await sbInsert('clients', {
      location_id: LOCATION_ID,
      full_name: link.client_name,
      phone: link.client_phone,
    });
    clientId = newClient.id;
  }

  // ---- car (optional — only if plate/model was given) ----
  let carId = null;
  if (link.plate || link.brand_model) {
    const newCar = await sbInsert('cars', {
      client_id: clientId,
      plate: link.plate,
      brand_model: link.brand_model,
      color: link.color,
      vehicle_type_id: link.vehicle_type_id,
    });
    carId = newCar.id;
  }

  // ---- the booking itself ----
  const extras = Array.isArray(link.extras) ? link.extras : [];
  const durationMinutes = (WASH_TYPE_DURATION_BY_ID[link.wash_type_id] || 60)
    + extras.reduce((s, e) => s + Number(e.duration_minutes || 0), 0);
  const scheduledAt = link.scheduled_at;
  const scheduledEnd = scheduledAt
    ? new Date(new Date(scheduledAt).getTime() + durationMinutes * 60000).toISOString()
    : null;

  const isFullyPaid = paidAmount >= Number(link.total_cost || link.amount);

  const booking = await sbInsert('bookings', {
    location_id: LOCATION_ID,
    client_id: clientId,
    car_id: carId,
    staff_id: link.staff_id,
    box_id: link.box_id,
    wash_type_id: link.wash_type_id,
    scheduled_at: scheduledAt,
    scheduled_end: scheduledEnd,
    status: 'confirmed', // NOTE: verify this matches the admin panel's expected status vocabulary
    source: 'site',
    total_price: link.total_cost || link.amount,
    payment_status: isFullyPaid ? 'paid' : 'not_paid',
    paid_amount: paidAmount,
    prepayment_status: isFullyPaid ? 'not_applicable' : 'paid',
    prepayment_amount: isFullyPaid ? 0 : paidAmount,
    notes: link.notes,
  });

  if (extras.length) {
    await Promise.all(extras.map((e) => sbInsert('booking_extras', {
      booking_id: booking.id,
      extra_service_id: e.id,
      price: e.price,
    })));
  }

  await sbUpdate('payment_links', { id: `eq.${link.id}` }, {
    status: 'paid',
    paid_at: new Date().toISOString(),
    booking_id: booking.id,
  });

  return { alreadyDone: false, bookingId: booking.id };
}

module.exports = { completePaidBooking };
