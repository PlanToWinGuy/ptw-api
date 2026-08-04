import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Maps a Stripe Price ID back to our own plan name -- the webhook only gets price IDs
// off the subscription object, but the users table stores the human-readable plan.
export const PLAN_BY_PRICE = {
  [process.env.STRIPE_PRICE_MONTHLY]: 'monthly',
  [process.env.STRIPE_PRICE_ANNUAL]: 'annual',
};

export const PRICE_BY_PLAN = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
};
