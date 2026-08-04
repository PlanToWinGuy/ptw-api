// One-off setup script: creates the PTW Membership product/prices and the production
// webhook endpoint via the Stripe API instead of manual Dashboard clicks, since the
// exact CAD amounts and the webhook target URL are both already known. Safe to re-run
// (each run creates fresh objects -- old ones can be archived in the Dashboard).
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function main() {
  const product = await stripe.products.create({
    name: 'PTW Membership (Beta)',
    description: 'Plan To Win — full app membership',
  });

  const monthly = await stripe.prices.create({
    product: product.id,
    currency: 'cad',
    unit_amount: 1299, // $12.99 CAD
    recurring: { interval: 'month' },
    nickname: 'Monthly',
  });

  const annual = await stripe.prices.create({
    product: product.id,
    currency: 'cad',
    unit_amount: 11691, // $116.91 CAD = 9 months (3 months free early-bird promo)
    recurring: { interval: 'year' },
    nickname: 'Annual — 3 months free (early bird)',
  });

  const webhook = await stripe.webhookEndpoints.create({
    url: 'https://ptw-api.vercel.app/api/billing/webhook',
    enabled_events: [
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ],
  });

  console.log('\n=== PTW Membership Stripe setup complete ===');
  console.log('Product:        ', product.id);
  console.log('STRIPE_PRICE_MONTHLY=', monthly.id);
  console.log('STRIPE_PRICE_ANNUAL=', annual.id);
  console.log('STRIPE_WEBHOOK_SECRET=', webhook.secret);
  console.log('=============================================\n');
}

main().catch(err => { console.error(err); process.exit(1); });
