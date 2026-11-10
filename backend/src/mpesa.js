// M-Pesa (Safaricom Daraja) integration layer.
//
// ARCHITECTURE:
//  - All M-Pesa secrets live ONLY in server environment variables. They are
//    NEVER sent to the frontend.
//  - When credentials are NOT configured, STK push returns 501
//    MPESA_NOT_CONFIGURED and the gate falls back to honest manual recording
//    (verification_status = 'manual'), clearly labelled in the UI and reports.
//  - When configured, STK push creates a payment_transactions row with status
//    'pending'. Only the server-side callback endpoint may flip it to 'paid'.
//  - A transaction is NEVER marked paid just because somebody typed a code.
//
// Required env (production):
//   MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE,
//   MPESA_PASSKEY, MPESA_CALLBACK_URL, MPESA_ENV=sandbox|production
const https = require('https');

function mpesaConfig() {
  return {
    consumerKey: process.env.MPESA_CONSUMER_KEY || '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
    shortcode: process.env.MPESA_SHORTCODE || '',
    passkey: process.env.MPESA_PASSKEY || '',
    callbackUrl: process.env.MPESA_CALLBACK_URL || '',
    env: process.env.MPESA_ENV || 'sandbox'
  };
}

function isConfigured() {
  const c = mpesaConfig();
  return Boolean(c.consumerKey && c.consumerSecret && c.shortcode && c.passkey && c.callbackUrl);
}

// Public-safe status (no secrets).
function publicStatus() {
  const c = mpesaConfig();
  return {
    configured: isConfigured(),
    env: c.env,
    shortcodeMasked: c.shortcode ? String(c.shortcode).slice(0, 2) + '****' : null,
    // NEVER expose keys/secrets here.
    requiredEnv: ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_URL']
  };
}

function darajaHost(env) {
  return env === 'production' ? 'api.safaricom.co.ke' : 'sandbox.safaricom.co.ke';
}

function httpJson({ host, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const req = https.request({ host, path, method, headers: { ...(headers || {}), ...(data ? { 'Content-Length': data.length } : {}) } }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }); }
        catch (e) { reject(new Error('Invalid JSON from Daraja')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('Daraja request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

async function getAccessToken() {
  const c = mpesaConfig();
  const auth = Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64');
  const { status, body } = await httpJson({
    host: darajaHost(c.env),
    path: '/oauth/v1/generate?grant_type=client_credentials',
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` }
  });
  if (status !== 200 || !body.access_token) throw new Error('Daraja OAuth failed');
  return body.access_token;
}

function stkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

function timestampNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Initiate STK push via Daraja. Throws when not configured or on API error.
// Returns { CheckoutRequestID, MerchantRequestID, CustomerMessage }.
async function initiateStkPush({ phone, amount }) {
  if (!isConfigured()) {
    const err = new Error('M-Pesa is not configured on the server.');
    err.code = 'MPESA_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }
  const c = mpesaConfig();
  const token = await getAccessToken();
  const ts = timestampNow();
  const payload = JSON.stringify({
    BusinessShortCode: c.shortcode,
    Password: stkPassword(c.shortcode, c.passkey, ts),
    Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(Number(amount)),
    PartyA: String(phone).replace(/^\+/, ''),
    PartyB: c.shortcode,
    PhoneNumber: String(phone).replace(/^\+/, ''),
    CallBackURL: c.callbackUrl,
    AccountReference: 'MarbleArchParking',
    TransactionDesc: 'Parking fee'
  });
  const { status, body } = await httpJson({
    host: darajaHost(c.env),
    path: '/mpesa/stkpush/v1/processrequest',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (status !== 200 || body.ResponseCode !== '0') {
    const err = new Error(body.ResponseDescription || body.errorMessage || 'STK push failed');
    err.code = 'MPESA_STK_FAILED';
    err.status = 502;
    throw err;
  }
  return body;
}

// Parse a Daraja STK callback body into a normalized result.
// Returns { checkoutRequestId, resultCode, resultDesc, receipt, amount, phone, date }
function parseCallback(body) {
  const cb = (body && body.Body && body.Body.stkCallback) || {};
  const items = (((cb.CallbackMetadata || {}).Item) || []).reduce((m, it) => {
    m[it.Name] = it.Value;
    return m;
  }, {});
  return {
    checkoutRequestId: cb.CheckoutRequestID || null,
    merchantRequestId: cb.MerchantRequestID || null,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc || '',
    receipt: items.MpesaReceiptNumber || null,
    amount: items.Amount != null ? Number(items.Amount) : null,
    phone: items.PhoneNumber != null ? String(items.PhoneNumber) : null,
    date: items.TransactionDate != null ? String(items.TransactionDate) : null
  };
}

module.exports = { mpesaConfig, isConfigured, publicStatus, initiateStkPush, parseCallback };
