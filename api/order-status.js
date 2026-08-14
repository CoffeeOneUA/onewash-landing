const { sbSelect, sbUpdate } = require('./_lib/supabase');
const { checkTransactionStatus } = require('./_lib/wayforpay');
const { completePaidBooking } = require('./_lib/completeBooking');
const { WASH_TYPES } = require('./_lib/domain');

// Statuses WayForPay's CHECK_STATUS can return that mean "money is in, book it".
// (Same string WayForPay uses on the serviceUrl webhook's transactionStatus field.)
const APPROVED = 'Approved';
// Statuses that mean the payment definitively did not go through — safe to stop polling.
const DEAD_STATUSES = new Set(['Declined', 'Expired', 'Refunded', 'Voided']);

const WASH_TYPE_DURATION_BY_ID = Object.fromEntries(Object.values(WASH_TYPES).map((w) => [w.id, w.duration]));

function durationMinutesFor(link) {
  const base = WASH_TYPE_DURATION_BY_ID[link.wash_type_id] || 60;
  const extras = Array.isArray(link.extras) ? link.extras : [];
  return base + extras.reduce((s, e) => s + Number(e.duration_minutes || 0), 0);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { ref } = req.query;
  if (!ref) { res.status(400).json({ error: 'Missing ref' }); return; }

  try {
    const rows = await sbSelect('payment_links', {
      select: '*',
      order_reference: `eq.${ref}`,
      limit: '1',
    });
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    let link = rows[0];

    // Safety net: don't just wait passively for the webhook. If the customer is
    // back on the site and we're still 'pending', actively ask WayForPay what
    // really happened — this is what protects against a webhook that never fires
    // (wrong serviceUrl, transient network issue, etc). completePaidBooking() is
    // idempotent, so this is safe even if the webhook fires around the same time.
    if (link.status === 'pending') {
      const remote = await checkTransactionStatus(ref);
      const remoteStatus = remote?.transactionStatus;
      if (remoteStatus === APPROVED) {
        try {
          await completePaidBooking(link, Number(remote.amount ?? link.amount));
          const refreshed = await sbSelect('payment_links', { select: '*', order_reference: `eq.${ref}`, limit: '1' });
          if (refreshed.length) link = refreshed[0];
        } catch (err) {
          console.error('order-status: completePaidBooking failed during active check', ref, err);
        }
      } else if (remoteStatus && DEAD_STATUSES.has(remoteStatus)) {
        await sbUpdate('payment_links', { id: `eq.${link.id}` }, { status: 'failed' });
        link = { ...link, status: 'failed' };
      }
      // remoteStatus === 'InProcessing'/'Pending'/null (request failed) => stay pending, client can poll again.
    }

    const durationMinutes = durationMinutesFor(link);
    const scheduledEnd = link.scheduled_at
      ? new Date(new Date(link.scheduled_at).getTime() + durationMinutes * 60000).toISOString()
      : null;

    res.status(200).json({
      status: link.status,
      client_name: link.client_name,
      amount: link.amount,
      total_cost: link.total_cost,
      scheduled_at: link.scheduled_at,
      scheduled_end: scheduledEnd,
      duration_minutes: durationMinutes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
};
