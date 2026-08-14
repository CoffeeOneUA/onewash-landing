const { sbSelect } = require('./_lib/supabase');
const { LOCATION_ID } = require('./_lib/domain');

function isValidPhone(phone) {
  return /^\+?\d{9,13}$/.test(String(phone || '').replace(/[\s()-]/g, ''));
}

// Public, minimal "we recognize you" lookup for the booking form — mirrors what the admin
// panel already does when a staff member types a returning client's phone number (auto-fills
// their last car instead of making them retype it, and keeps a second `cars` row from getting
// created for the same plate). Only ever looked up by the caller's own phone number they just
// typed, and only ever returns name + last car — never payment/booking history.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const phone = String(req.query.phone || '').trim();
  if (!isValidPhone(phone)) { res.status(200).json({ found: false }); return; }

  try {
    const clients = await sbSelect('clients', {
      select: 'id,full_name',
      location_id: `eq.${LOCATION_ID}`,
      phone: `eq.${phone}`,
      limit: '1',
    });
    const client = clients[0];
    if (!client) { res.status(200).json({ found: false }); return; }

    const cars = await sbSelect('cars', {
      select: 'plate,brand_model,color,vehicle_type_id,created_at',
      client_id: `eq.${client.id}`,
      order: 'created_at.desc',
      limit: '1',
    });
    const car = cars[0];

    res.status(200).json({
      found: true,
      name: client.full_name || null,
      car: car ? {
        plate: car.plate || null,
        brandModel: car.brand_model || null,
        color: car.color || null,
        vehicleTypeId: car.vehicle_type_id || null,
      } : null,
    });
  } catch (err) {
    console.error(err);
    // Fail soft — this is a convenience lookup, never block the booking form over it.
    res.status(200).json({ found: false });
  }
};
