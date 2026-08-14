// WayForPay signature helpers.
// Spec: https://wiki.wayforpay.com/ (Purchase request + ServiceUrl callback).
// NOTE: this integration has not been tested against a real WayForPay account yet —
// run a test transaction (WayForPay provides test card numbers) before going live.

const crypto = require('crypto');

const MERCHANT_ACCOUNT = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
const SECRET_KEY = process.env.WAYFORPAY_SECRET_KEY;

// WayForPay's merchantDomainName expects a bare host (e.g. "www.onewash.com.ua"),
// not a full URL — strip protocol/path/trailing slash so this works regardless of
// how the env var was entered (defensive: this has caused a real failed payment before).
const DOMAIN = (process.env.WAYFORPAY_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

function assertConfigured() {
  if (!MERCHANT_ACCOUNT || !SECRET_KEY || !DOMAIN) {
    throw new Error('WAYFORPAY_MERCHANT_ACCOUNT / WAYFORPAY_SECRET_KEY / WAYFORPAY_DOMAIN not set');
  }
}

function hmacMd5(str) {
  return crypto.createHmac('md5', SECRET_KEY).update(str, 'utf8').digest('hex');
}

/**
 * Builds a signed WayForPay "Purchase" request payload.
 * productName/productPrice/productCount must be parallel arrays (one entry per line item).
 */
function buildPurchaseRequest({ orderReference, orderDate, amount, productName, productPrice, productCount, clientEmail, clientPhone, returnUrl, serviceUrl }) {
  assertConfigured();
  const currency = 'UAH';
  const signatureString = [
    MERCHANT_ACCOUNT,
    DOMAIN,
    orderReference,
    orderDate,
    amount,
    currency,
    ...productName,
    ...productCount,
    ...productPrice,
  ].join(';');

  const merchantSignature = hmacMd5(signatureString);

  return {
    merchantAccount: MERCHANT_ACCOUNT,
    merchantDomainName: DOMAIN,
    merchantSignature,
    orderReference,
    orderDate,
    amount,
    currency,
    productName,
    productPrice,
    productCount,
    clientEmail: clientEmail || undefined,
    clientPhone: clientPhone || undefined,
    returnUrl,
    serviceUrl,
    language: 'UA',
  };
}

/** Verifies the signature WayForPay sends on the serviceUrl (webhook) callback. */
function verifyCallbackSignature(payload) {
  assertConfigured();
  const { merchantAccount, orderReference, amount, currency, authCode, cardPan, transactionStatus, reasonCode, merchantSignature } = payload;
  const str = [merchantAccount, orderReference, amount, currency, authCode, cardPan, transactionStatus, reasonCode].join(';');
  const expected = hmacMd5(str);
  return expected === merchantSignature;
}

/** Builds the acknowledgement response WayForPay expects back from the webhook. */
function buildAckResponse(orderReference) {
  const time = Math.floor(Date.now() / 1000);
  const status = 'accept';
  const signature = hmacMd5([orderReference, status, time].join(';'));
  return { orderReference, status, time, signature };
}

/**
 * Actively asks WayForPay for a transaction's real status, instead of only waiting
 * passively for the serviceUrl webhook. Used as a safety net: called when the
 * customer returns to the site after checkout and payment_links is still 'pending'.
 * Returns the raw WayForPay response (has .transactionStatus, .amount, etc.) or
 * null if the request itself failed (network error, WayForPay down, etc).
 */
async function checkTransactionStatus(orderReference) {
  assertConfigured();
  const signature = hmacMd5([MERCHANT_ACCOUNT, orderReference].join(';'));
  try {
    const res = await fetch('https://api.wayforpay.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactionType: 'CHECK_STATUS',
        merchantAccount: MERCHANT_ACCOUNT,
        orderReference,
        merchantSignature: signature,
        apiVersion: 1,
      }),
    });
    if (!res.ok) {
      console.error('WayForPay CHECK_STATUS HTTP error', res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('WayForPay CHECK_STATUS request failed', err);
    return null;
  }
}

module.exports = { buildPurchaseRequest, verifyCallbackSignature, buildAckResponse, checkTransactionStatus, hmacMd5 };
