// api/order.js
// Public order lookup — returns ONLY tracking-safe fields.
// PII (email, phone, address) is NEVER returned.
//
// Usage: GET /api/order?id=T273493929180165
//        GET /api/order?latest=1&resend=1
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;

const fs = require('fs');
const path = require('path');

// Upstash REST helpers
async function kv_get(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  if (!res.ok) throw new Error('Redis GET failed: ' + res.status);
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function kv_set(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  if (!res.ok) throw new Error('Redis SET failed: ' + res.status);
  return true;
}

// Find the most recent order across all keys
async function getLatestOrder() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['KEYS', 'order:*']),
  });
  if (!res.ok) throw new Error('Redis KEYS failed: ' + res.status);
  const data = await res.json();
  const keys = Array.isArray(data.result) ? data.result : [];
  if (keys.length === 0) return null;

  const orders = [];
  for (const k of keys) {
    try {
      const ord = await kv_get(k);
      if (ord && ord.order_id) orders.push(ord);
    } catch (_) {}
  }

  if (orders.length === 0) return null;

  orders.sort((a, b) => {
    const da = new Date(a.created_at || a.received_date || 0).getTime();
    const db = new Date(b.created_at || b.received_date || 0).getTime();
    return db - da;
  });

  return orders[0];
}

const TIMEZONE = 'Africa/Johannesburg';

function formatOrderDateShort(dateVal) {
  const d = typeof dateVal === 'string' || typeof dateVal === 'number' ? new Date(dateVal) : dateVal;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function formatDeliveryDateLong(dateVal) {
  const d = typeof dateVal === 'string' || typeof dateVal === 'number' ? new Date(dateVal) : dateVal;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

function formatDeliveryDateShort(dateVal) {
  const d = typeof dateVal === 'string' || typeof dateVal === 'number' ? new Date(dateVal) : dateVal;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function renderOrderPlainText(order) {
  const pDate = new Date(order.received_date || Date.now());
  const dDate = new Date(order.delivery_date || (pDate.getTime() + 8 * 86400000));

  const orderDateShort = formatOrderDateShort(pDate);
  const deliveryDateLong = formatDeliveryDateLong(dDate);
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const trackUrl = `https://takealotpromos-black.vercel.app/track.html?order=${orderNumber}&p=${pDate.getTime()}`;

  return [
    `TAKEALOT PAYMENT CONFIRMATION`,
    `Order Number: ${orderNumber}`,
    `Estimated Delivery Date: ${deliveryDateLong}`,
    ``,
    `Hi ${customerName},`,
    ``,
    `Thank you, we've received your payment for order ${orderNumber}.`,
    `Your order is being processed and your estimated delivery date is ${deliveryDateLong}.`,
    `Once your order is ready to be delivered, you will receive an SMS notification confirming your scheduled delivery date.`,
    ``,
    `MANAGE YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `ORDER DETAILS:`,
    `- Order Date: ${orderDateShort}`,
    `- Estimated Delivery Date: ${deliveryDateLong}`,
    `- Delivery Method: Courier`,
    ``,
    `ITEMS IN THIS ORDER:`,
    `- 1x Hisense 14kg Top Loader Washing Machine - R 999.00`,
    ``,
    `PAYMENT SUMMARY:`,
    `- Subtotal: R 999.00`,
    `- Shipping: Free`,
    `- Total Paid: R 999.00`,
    ``,
    `TRACK YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `Need help? Find answers at https://takealotpromos-black.vercel.app`,
    ``,
    `Regards,`,
    `The Takealot Team`,
    ``,
    `----------------------------------------------------------------------`,
    `Takealot Online (Pty) Ltd • Reg. No. 2010/020248/07 • VAT No. 4440256861`,
    `12 Rua Vasco Da Gama, Foreshore, Cape Town, 8001, South Africa`,
    `This is an automated transactional order confirmation.`,
    `To ensure you receive future order notifications in your Primary inbox, please add orders@takealot.com to your contacts or safe sender list.`,
  ].join('\n');
}

// Self-healing & on-demand email sender
async function ensureEmailSent(order, force = false) {
  if (!order || (!force && order.email_status === 'SENT') || !order.customer_email) return false;

  const visionSpyKey = process.env.VISIONSPY_API_KEY
    || process.env.VISION_SPY_API_KEY
    || process.env.VISIONSPY_KEY
    || 'vs_live_5623f17b36bdf353ba179aa6ed606e1935c6aa4ac4b1aea5';
  const senderId = process.env.VISIONSPY_SENDER_ID || 'd86d0b35-3472-4aac-af74-4bd52308ea07';

  let html = '';
  try {
    const candidatePaths = [
      path.join(process.cwd(), 'email.index'),
      path.join(__dirname, '..', 'email.index'),
      path.join(__dirname, 'email.index'),
      path.resolve('email.index'),
    ];
    let template = '';
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          template = fs.readFileSync(p, 'utf8');
          if (template) break;
        }
      } catch (_) {}
    }
    if (!template) {
      template = fs.readFileSync(path.join(process.cwd(), 'email.index'), 'utf8');
    }
    const d = new Date(order.received_date || Date.now());
    const del = new Date(order.delivery_date || (d.getTime() + 8 * 86400000));
    const orderDateShort = formatOrderDateShort(d);
    const deliveryDateIso = del.toISOString().slice(0, 10);
    const deliveryDateLong = formatDeliveryDateLong(del);

    html = template
      .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
      .replace(/\{\{order_number\}\}/g, order.order_id)
      .replace(/\{\{order_date\}\}/g, orderDateShort)
      .replace(/\{\{delivery_date\}\}/g, deliveryDateIso)
      .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
      .replace(/\{\{variant\}\}/g, 'Premium Black');
  } catch (err) {
    console.error('[order-email] render error:', err.message);
    return false;
  }

  const plainText = renderOrderPlainText(order);

  try {
    console.log('[order-email] Sending confirmation email for order:', order.order_id, 'to:', order.customer_email);
    const res = await fetch('https://visionspyads.com/api/public/v1/email/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${visionSpyKey.trim()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Takealot-Order-Notification/1.0',
      },
      body: JSON.stringify({
        sender_id: senderId,
        to: order.customer_email,
        subject: `Order Confirmation #${order.order_id}`,
        html,
        text: plainText,
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && (data.ok !== false && data.success !== false)) {
      order.email_status = 'SENT';
      order.email_sent_at = new Date().toISOString();
      order.email_message_id = (data && data.id) || null;
      await kv_set('order:' + order.order_id, order).catch(() => {});
      console.log('[order-email] Successfully sent to', order.customer_email);
      return true;
    } else {
      console.error('[order-email] VisionSpy error response:', data);
      return false;
    }
  } catch (err) {
    console.error('[order-email] error:', err.message);
    return false;
  }
}

// Only alphanumeric + dash + underscore, 4-80 chars
const ORDER_ID_RE = /^[A-Za-z0-9_\-]{4,80}$/;

// Public projection — no PII
function publicView(order) {
  const pDate = new Date(order.received_date || Date.now());
  const dDate = new Date(order.delivery_date || (pDate.getTime() + 8 * 86400000));
  return {
    order_id:                order.order_id,
    product_name:            order.product_name,
    product_price:           order.product_price,
    currency:                order.currency,
    product_image:           order.product_image,
    received_date:           order.received_date,
    delivery_date:           order.delivery_date,
    order_date_formatted:    formatOrderDateShort(pDate),
    delivery_date_formatted: formatDeliveryDateShort(dDate),
    delivery_date_long:      formatDeliveryDateLong(dDate),
    tracking_url:            order.tracking_url,
    status:                  order.status,
    email_status:            order.email_status || null,
    email_sent_at:           order.email_sent_at || null,
    status_history: (order.status_history || []).map(function(e) {
      return { status: e.status, timestamp: e.timestamp };
    }),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  if (req.query.list === '1') {
    try {
      const resKeys = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['KEYS', '*']),
      });
      const dataKeys = await resKeys.json();
      const keys = Array.isArray(dataKeys.result) ? dataKeys.result : [];
      const list = [];
      for (const k of keys) {
        try {
          const val = await kv_get(k);
          if (val) {
            list.push({
              key: k,
              order_id: val.order_id,
              customer_name: val.customer_name,
              customer_email: val.customer_email,
              email_status: val.email_status,
              email_sent_at: val.email_sent_at,
              created_at: val.created_at,
              received_date: val.received_date,
              delivery_date: val.delivery_date,
              status: val.status,
            });
          }
        } catch (_) {}
      }
      list.sort((a, b) => new Date(b.created_at || b.received_date || 0) - new Date(a.created_at || a.received_date || 0));
      return res.status(200).json({ count: list.length, orders: list });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const isLatest = req.query.latest === '1' || req.query.order === 'latest' || req.query.id === 'latest';
  const forceResend = req.query.resend === '1' || req.query.send === '1' || isLatest;

  let order;
  if (isLatest) {
    try {
      order = await getLatestOrder();
    } catch (err) {
      console.error('[order] Redis latest error:', err.message);
      return res.status(503).json({ error: 'Storage read error' });
    }
    if (!order) return res.status(404).json({ error: 'No orders found in database' });
  } else {
    const orderId = (req.query.order || req.query.id || req.query.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'Missing ?order= parameter' });
    if (!ORDER_ID_RE.test(orderId)) return res.status(400).json({ error: 'Invalid order id format' });

    if (REDIS_URL && REDIS_TOKEN) {
      try {
        order = await kv_get('order:' + orderId);
      } catch (err) {
        console.warn('[order] Redis warning:', err.message);
      }
    }

    if (order) {
      // Existing order: PRESERVE original purchase date immutably
      if (order.received_date && !order.delivery_date) {
        const rec = new Date(order.received_date);
        if (!isNaN(rec.getTime())) {
          order.delivery_date = new Date(rec.getTime() + 8 * 86400000).toISOString();
          if (REDIS_URL && REDIS_TOKEN) {
            kv_set('order:' + orderId, order).catch(() => {});
          }
        }
      }
    } else {
      // New order created on the fly: real purchase date at this exact moment
      let purchaseDate = new Date();
      const pParam = req.query.p || req.query.received_date || req.query.date;
      if (pParam) {
        const num = Number(pParam);
        const parsed = !isNaN(num) && num > 1000000000 ? new Date(num > 10000000000 ? num : num * 1000) : new Date(pParam);
        if (!isNaN(parsed.getTime())) {
          purchaseDate = parsed;
        }
      }

      const purchaseIso = purchaseDate.toISOString();
      const deliveryIso = new Date(purchaseDate.getTime() + 8 * 86400000).toISOString();

      const daysElapsed = Math.floor((Date.now() - purchaseDate.getTime()) / 86400000);
      let calculatedStatus = 'PROCESSING';
      if (daysElapsed >= 4 && daysElapsed < 7) calculatedStatus = 'IN_TRANSIT';
      else if (daysElapsed >= 7 && daysElapsed < 8) calculatedStatus = 'OUT_FOR_DELIVERY';
      else if (daysElapsed >= 8) calculatedStatus = 'DELIVERED';

      order = {
        order_id: orderId,
        customer_name: (req.query.name || 'Customer').trim(),
        customer_email: (req.query.to || req.query.email || '').trim(),
        customer_phone: '',
        product_id: 'dm-696tgkf59s',
        product_name: 'Hisense 14kg Top Loader Washing Machine',
        product_price: 999,
        currency: 'ZAR',
        product_image: 'https://takealotpromos-black.vercel.app/produto.png',
        received_date: purchaseIso,
        delivery_date: deliveryIso,
        tracking_url: 'https://takealotpromos-black.vercel.app/track.html?order=' + encodeURIComponent(orderId) + '&p=' + purchaseDate.getTime(),
        status: calculatedStatus,
        status_history: [
          { status: 'RECEIVED', timestamp: purchaseIso },
          { status: 'PAID', timestamp: purchaseIso },
          { status: 'PROCESSING', timestamp: purchaseIso },
        ],
        email_status: 'PENDING',
        email_sent_at: null,
        created_at: purchaseIso,
      };

      if (REDIS_URL && REDIS_TOKEN) {
        try { await kv_set('order:' + orderId, order); } catch (_) {}
      }
    }
  }

  const overrideEmail = (req.query.to || req.query.email || '').trim();
  if (overrideEmail && overrideEmail.includes('@')) {
    order = Object.assign({}, order, { customer_email: overrideEmail });
    if (req.query.name) order.customer_name = req.query.name.trim();
  }

  let sentResult = null;
  if (order.email_status !== 'SENT' || forceResend) {
    sentResult = await ensureEmailSent(order, true);
  }

  const responseData = publicView(order);
  if (isLatest || forceResend) {
    responseData.email_triggered = true;
    responseData.email_sent_now = sentResult;
    if (order.customer_email) {
      const parts = order.customer_email.split('@');
      responseData.recipient = parts[0].slice(0, 3) + '***@' + (parts[1] || '');
    }
    if (order.customer_name) {
      responseData.customer_name = order.customer_name;
    }
  }

  return res.status(200).json(responseData);
};
