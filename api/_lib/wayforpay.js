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

module.exports = { buildPurchaseRequest, verifyCallbackSignature, buildAckResponse, hmacMd5 };
