const { sbSelect, sbInsert } = require('./_lib/supabase');
const { LOCATION_ID, WASH_TYPES, VEHICLE_TYPES, DEFAULT_DEPOSIT } = require('./_lib/domain');
const { getAvailableSlots, kyivWallToUtcIso } = require('./_lib/availability');
const { buildPurchaseRequest } = require('./_lib/wayforpay');
const crypto = require('crypto');

const WASH_TYPE_BY_KEY = Object.fromEntries(Object.entries(WASH_TYPES).map(([k, v]) => [k, v]));
const VEHICLE_ID_SET = new Set(Object.values(VEHICLE_TYPES));

function isValidPhone(phone) {
  return /^\+?\d{9,13}$/.test(String(phone).replace(/[\s()-]/g, ''));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const {
      washTypeKey, vehicleTypeId, extraServiceIds = [],
      date, time, name, phone, plate, brandModel,
      payMode,
    } = body;

    // ---- validate ----
    const errors = [];
    const washType = WASH_TYPE_BY_KEY[washTypeKey];
    if (!washType) errors.push('washTypeKey');
    if (!VEHICLE_ID_SET.has(vehicleTypeId)) errors.push('vehicleTypeId');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('date');
    if (!time || !/^\d{2}:\d{2}$/.test(time)) errors.push('time');
    if (!name || String(name).trim().length < 2) errors.push('name');
    if (!phone || !isValidPhone(phone)) errors.push('phone');
    if (!['full', 'deposit'].includes(payMode)) errors.push('payMode');
    if (!Array.isArray(extraServiceIds)) errors.push('extraServiceIds');
    if (errors.length) {
      res.status(400).json({ error: 'Invalid fields', fields: errors });
      return;
    }

    // ---- real price, computed server-side (never trust client-submitted amounts) ----
    const priceRows = await sbSelect('wash_prices', {
      select: 'price',
      wash_type_id: `eq.${washType.id}`,
      vehicle_type_id: `eq.${vehicleTypeId}`,
    });
    if (!priceRows.length) {
      res.status(400).json({ error: 'No price configured for this wash type / vehicle combination' });
      return;
    }
    const washPrice = Number(priceRows[0].price);

    let extras = [];
    if (extraServiceIds.length) {
      extras = await sbSelect('extra_services', {
        select: 'id,name,price,duration_minutes',
        id: `in.(${extraServiceIds.join(',')})`,
        is_active: 'eq.true',
      });
      if (extras.length !== extraServiceIds.length) {
        res.status(400).json({ error: 'One or more extra services are invalid or inactive' });
        return;
      }
    }
    const extrasTotal = extras.reduce((s, e) => s + Number(e.price), 0);
    const extrasDuration = extras.reduce((s, e) => s + Number(e.duration_minutes || 0), 0);
    const totalCost = washPrice + extrasTotal;
    const durationMinutes = washType.duration + extrasDuration;
    const amount = payMode === 'deposit' ? DEFAULT_DEPOSIT : totalCost;

    // ---- re-verify the slot is still free and pick a staff member ----
    const slots = await getAvailableSlots(date, durationMinutes);
    const slot = slots.find((s) => s.time === time);
    if (!slot) {
      res.status(409).json({ error: 'Цей час щойно стало зайнято, оберіть інший' });
      return;
    }
    const staffId = slot.staffIds[0];
    const boxId = slot.boxIds ? slot.boxIds[0] : null; // null when the location has no wash_boxes configured
    const scheduledAt = kyivWallToUtcIso(date, time);
    const scheduledEnd = new Date(new Date(scheduledAt).getTime() + durationMinutes * 60000).toISOString();

    // ---- create the payment_links row (the same table the admin app already uses) ----
    const orderReference = `ow-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const notesLines = [
      `Пакет: ${washType.name} — ${washPrice} грн`,
      extras.length ? `Додатково: ${extras.map((e) => `${e.name} (${e.price} грн)`).join(', ')}` : null,
      `Разом: ${totalCost} грн`,
      payMode === 'deposit' ? `Оплата зараз: передоплата ${DEFAULT_DEPOSIT} грн, решта на місці` : 'Оплата зараз: повна сума',
      'Джерело: сайт (onewash-landing)',
    ].filter(Boolean);

    await sbInsert('payment_links', {
      location_id: LOCATION_ID,
      order_reference: orderReference,
      client_phone: phone,
      client_name: name,
      amount,
      total_cost: totalCost,
      wash_type_id: washType.id,
      vehicle_type_id: vehicleTypeId,
      staff_id: staffId,
      box_id: boxId,
      scheduled_at: scheduledAt,
      plate: plate || null,
      brand_model: brandModel || null,
      extras: extras.map((e) => ({ id: e.id, name: e.name, price: e.price, duration_minutes: e.duration_minutes })),
      notes: notesLines.join('\n'),
      status: 'pending',
    });

    // ---- build the signed WayForPay purchase request ----
    const orderDate = Math.floor(Date.now() / 1000);
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const purchase = buildPurchaseRequest({
      orderReference,
      orderDate,
      amount,
      productName: [`${washType.name} — One Wash`, ...extras.map((e) => e.name)],
      productPrice: [washPrice, ...extras.map((e) => Number(e.price))],
      productCount: [1, ...extras.map(() => 1)],
      clientPhone: phone,
      returnUrl: `${origin}/?order=${orderReference}`,
      serviceUrl: `${origin}/api/wayforpay-callback`,
    });

    console.log('WayForPay purchase created', {
      orderReference,
      amount,
      merchantDomainName: purchase.merchantDomainName,
      serviceUrl: purchase.serviceUrl,
      returnUrl: purchase.returnUrl,
    });

    res.status(200).json({ orderReference, scheduledEnd, purchase });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
};
