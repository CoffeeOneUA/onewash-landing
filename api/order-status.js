const { sbSelect } = require('./_lib/supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { ref } = req.query;
  if (!ref) { res.status(400).json({ error: 'Missing ref' }); return; }

  try {
    const rows = await sbSelect('payment_links', {
      select: 'status,client_name,amount,total_cost,scheduled_at',
      order_reference: `eq.${ref}`,
      limit: '1',
    });
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(200).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
};
