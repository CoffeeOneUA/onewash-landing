const { sbSelect, sbInsert, sbUpdate } = require('./_lib/supabase');
const { LOCATION_ID, WASH_TYPES } = require('./_lib/domain');
const { verifyCallbackSignature, buildAckResponse } = require('./_lib/wayforpay');

const WASH_TYPE_DURATION_BY_ID = Object.fromEntries(Object.values(WASH_TYPES).map((w) => [w.id, w.duration]));

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const { orderReference, transactionStatus, amount } = payload;
  if (!orderReference) { res.status(400).json({ error: 'Missing orderReference' }); return; }

  // Always try to acknowledge in the format WayForPay expects, even on internal errors below,
  // so it doesn't keep retrying forever — but only after signature is verified.
  let signatureOk = false;
  try {
    signatureOk = verifyCallbackSignature(payload);
  } catch (e) {
    console.error('WayForPay signature check failed to run:', e);
  }
  if (!signatureOk) {
    console.error('WayForPay callback: signature mismatch', orderReference);
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    const links = await sbSelect('payment_links', { select: '*', order_reference: `eq.${orderReference}` });
    const link = links[0];
    if (!link) {
      console.error('WayForPay callback: unknown orderReference', orderReference);
      res.status(200).json(buildAckResponse(orderReference)); // ack anyway, nothing to retry
      return;
    }

    // Idempotency: already processed.
    if (link.status === 'paid' && link.booking_id) {
      res.status(200).json(buildAckResponse(orderReference));
      return;
    }

    if (transactionStatus !== 'Approved') {
      await sbUpdate('payment_links', { id: `eq.${link.id}` }, { status: 'failed' });
      res.status(200).json(buildAckResponse(orderReference));
      return;
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

    const paidAmount = Number(amount ?? link.amount);
    const isFullyPaid = paidAmount >= Number(link.total_cost || link.amount);

    const booking = await sbInsert('bookings', {
      location_id: LOCATION_ID,
      client_id: clientId,
      car_id: carId,
      staff_id: link.staff_id,
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

    res.status(200).json(buildAckResponse(orderReference));
  } catch (err) {
    console.error('WayForPay callback processing failed:', err);
    // Still ack so WayForPay doesn't hammer retries while we investigate; the payment_links
    // row stays 'pending' so it's visible for manual follow-up.
    res.status(200).json(buildAckResponse(orderReference));
  }
};
