// WayForPay's classic "Purchase" redirect flow returns the customer's browser to
// returnUrl using a POST (form submit with transaction fields), not a GET. A plain
// static index.html on Vercel only answers GET/HEAD — a POST to "/" gets rejected
// with a bare error page before any of our JS ever runs, which is very likely what
// showed up as a "blank white screen" right after a successful payment.
//
// So returnUrl points here instead of straight at "/": this is a real serverless
// function, so it accepts POST fine, and it always finishes with a 302 redirect to
// "/success.html?order=..." — which forces a fresh GET, so the static page (and its
// JS-driven order-status polling / confirmation UI) loads normally every time.
//
// Always targets success.html, even though the payment might turn out to have failed:
// success.html polls /api/order-status and redirects itself to payment-failed.html the
// moment the real status comes back 'failed'. Most returns here really are successful
// payments, so this keeps the common case to a single redirect instead of two.
module.exports = async (req, res) => {
  const ref = (req.query && req.query.order) || (req.body && req.body.orderReference) || '';
  const location = ref ? `/success.html?order=${encodeURIComponent(ref)}` : '/';
  res.writeHead(302, { Location: location });
  res.end();
};
