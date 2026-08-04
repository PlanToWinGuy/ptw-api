import { sql } from '../../lib/db.js';
import { stripe, PLAN_BY_PRICE } from '../../lib/stripe.js';

// Stripe requires the exact raw request bytes to verify the signature -- the default
// Vercel JSON body parser would re-serialize the body and break that check, so it's
// disabled here. This is why this endpoint is its own file rather than an action on
// api/billing.js (which needs normal JSON parsing for checkout/portal).
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function syncSubscription(customerId, subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = PLAN_BY_PRICE[priceId] || null;
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
  await sql`
    UPDATE users SET
      stripe_subscription_id = ${subscription.id},
      subscription_status = ${subscription.status},
      subscription_plan = ${plan},
      subscription_current_period_end = ${periodEnd}
    WHERE stripe_customer_id = ${customerId}
  `;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ message: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.client_reference_id) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await sql`
          UPDATE users SET stripe_customer_id = ${session.customer}
          WHERE id = ${Number(session.client_reference_id)}
        `;
        await syncSubscription(session.customer, subscription);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      await syncSubscription(subscription.customer, subscription);
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      await sql`
        UPDATE users SET subscription_status = 'canceled'
        WHERE stripe_customer_id = ${subscription.customer}
      `;
    }
  } catch (err) {
    console.error('Stripe webhook handling failed:', err);
    return res.status(500).json({ message: 'Webhook handler error' });
  }

  res.status(200).json({ received: true });
}
