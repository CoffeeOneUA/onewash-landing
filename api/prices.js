const { sbSelect } = require('./_lib/supabase');
const { LOCATION_ID, VEHICLE_TYPES, WASH_TYPES } = require('./_lib/domain');

// Live pricing for the public price table + booking calculator. Previously these were
// hardcoded snapshots baked into index.html at build time (a static <table> for the price
// grid, plus JS PACKAGES/EXTRAS arrays) — correct on the day they were written, but silently
// wrong the moment an admin changed a price in services.html, since nothing rebuilt the site.
// The actual charge was always computed server-side from live data (create-payment.js), so
// customers only ever saw a stale number on the page itself, never got overcharged — but a
// mismatch between what's shown and what's charged is exactly the kind of thing that looks
// like a scam. This endpoint is now the single source of truth the front-end renders from.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const vehicleEntries = Object.entries(VEHICLE_TYPES); // [key, id][]
    const washEntries = Object.entries(WASH_TYPES); // [key, {id,name,duration}][]
    const vehicleIds = vehicleEntries.map(([, id]) => id);
    const washTypeIds = washEntries.map(([, w]) => w.id);

    const [vehicleRows, washTypeRows, priceRows, extraRows] = await Promise.all([
      sbSelect('vehicle_types', { select: 'id,name', id: `in.(${vehicleIds.join(',')})` }),
      sbSelect('wash_types', { select: 'id,name,duration_minutes', id: `in.(${washTypeIds.join(',')})` }),
      sbSelect('wash_prices', {
        select: 'wash_type_id,vehicle_type_id,price',
        wash_type_id: `in.(${washTypeIds.join(',')})`,
        vehicle_type_id: `in.(${vehicleIds.join(',')})`,
      }),
      sbSelect('extra_services', {
        select: 'id,name,price,duration_minutes',
        location_id: `eq.${LOCATION_ID}`,
        is_active: 'eq.true',
        order: 'name.asc',
      }),
    ]);

    const vehicleNameById = Object.fromEntries(vehicleRows.map((v) => [v.id, v.name]));
    const washTypeRowById = Object.fromEntries(washTypeRows.map((w) => [w.id, w]));
    const washKeyById = Object.fromEntries(washEntries.map(([key, w]) => [w.id, key]));
    const vehicleKeyById = Object.fromEntries(vehicleEntries.map(([key, id]) => [id, key]));

    const vehicles = vehicleEntries.map(([key, id]) => ({ key, id, name: vehicleNameById[id] || key }));
    const washTypes = washEntries.map(([key, w]) => ({
      key,
      id: w.id,
      name: washTypeRowById[w.id]?.name || w.name,
      duration: washTypeRowById[w.id]?.duration_minutes ?? w.duration,
    }));

    const prices = {};
    for (const row of priceRows) {
      const washKey = washKeyById[row.wash_type_id];
      const vehKey = vehicleKeyById[row.vehicle_type_id];
      if (!washKey || !vehKey) continue;
      prices[washKey] = prices[washKey] || {};
      prices[washKey][vehKey] = Number(row.price);
    }

    const extras = extraRows.map((e) => ({
      id: e.id,
      name: e.name,
      price: Number(e.price),
      duration: Number(e.duration_minutes || 0),
    }));

    // Cache briefly at the edge — prices don't change second-to-second, and this cuts DB
    // load on repeat visits, but stays short enough that an admin's price change shows up fast.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ vehicles, washTypes, prices, extras });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
};
