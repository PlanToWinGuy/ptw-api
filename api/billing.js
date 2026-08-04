import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { stripe, PRICE_BY_PLAN } from '../lib/stripe.js';

// Handles /api/billing/checkout and /api/billing/portal via vercel.json rewrites
// (?action=checkout|portal) -- consolidated into one function, same pattern as
// api/auth.js. The webhook is deliberately NOT here: it needs the raw request body for
// Stripe signature verification, which would conflict with this file's normal JSON body
// parsing, so it lives in its own file (api/billing/webhook.js).
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const action = req.query.action;
  // Membership can now be bought either from the logged-in app or from the map-of-you
  // funnel (a different origin) -- `source` picks which site Stripe hands the user back
  // to. Defaults to the app since that's still where an already-authenticated user's
  // Settings > Membership screen calls this from.
  const { source } = req.body || {};
  const baseUrl = source === 'map'
    ? (process.env.MAP_URL || 'https://map.plantowin.app')
    : (process.env.APP_URL || 'https://app.plantowin.app');

  if (action === 'checkout') {
    const { plan } = req.body || {};
    const priceId = PRICE_BY_PLAN[plan];
    if (!priceId) return res.status(422).json({ message: 'plan must be "monthly" or "annual"' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: String(user.id),
      ...(user.stripe_customer_id
        ? { customer: user.stripe_customer_id }
        : { customer_email: user.email }),
      success_url: `${baseUrl}/?billing=success`,
      cancel_url: `${baseUrl}/?billing=cancel`,
    });
    return res.status(200).json({ url: session.url });
  }

  if (action === 'portal') {
    if (!user.stripe_customer_id) {
      return res.status(400).json({ message: 'No subscription found for this account yet.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${baseUrl}/?billing=return`,
    });
    return res.status(200).json({ url: session.url });
  }

  res.status(404).json({ message: 'Unknown billing action' });
}
