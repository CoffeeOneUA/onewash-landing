const { sbSelect, sbUpdate } = require('./_lib/supabase');
const { verifyCallbackSignature, buildAckResponse } = require('./_lib/wayforpay');
const { completePaidBooking } = require('./_lib/completeBooking');

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
  console.log('WayForPay callback received', { orderReference, transactionStatus, amount, merchantAccount: payload.merchantAccount });
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
    console.error('WayForPay callback: signature mismatch', orderReference, JSON.stringify(payload));
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

    if (transactionStatus !== 'Approved') {
      if (link.status === 'pending') {
        await sbUpdate('payment_links', { id: `eq.${link.id}` }, { status: 'failed' });
      }
      res.status(200).json(buildAckResponse(orderReference));
      return;
    }

    const result = await completePaidBooking(link, Number(amount ?? link.amount));
    console.log('WayForPay callback: booking completed', { orderReference, ...result });

    res.status(200).json(buildAckResponse(orderReference));
  } catch (err) {
    console.error('WayForPay callback processing failed:', err);
    // Still ack so WayForPay doesn't hammer retries while we investigate; the payment_links
    // row stays 'pending' so the active status check (order-status.js) can still catch it.
    res.status(200).json(buildAckResponse(orderReference));
  }
};
