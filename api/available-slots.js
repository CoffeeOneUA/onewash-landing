const { getAvailableSlots } = require('./_lib/availability');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { date, duration } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid or missing "date" (expected YYYY-MM-DD)' });
      return;
    }
    const durationMinutes = Math.max(15, parseInt(duration, 10) || 60);

    const todayIso = new Date().toISOString().slice(0, 10);
    const maxIso = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
    if (date < todayIso || date > maxIso) {
      res.status(200).json({ slots: [] });
      return;
    }

    const slots = await getAvailableSlots(date, durationMinutes);
    res.status(200).json({ slots: slots.map((s) => s.time) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
};
