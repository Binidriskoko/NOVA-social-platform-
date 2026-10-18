import env from '../config/env.js';

type CommerceRecord = Record<string, any>;

type CommerceState = {
  creators: CommerceRecord[];
  creatorSubscriptions: CommerceRecord[];
  creatorLedger: CommerceRecord[];
  creatorPayouts: CommerceRecord[];
  businesses: CommerceRecord[];
  businessMembers: CommerceRecord[];
  businessFollowers: CommerceRecord[];
  businessPosts: CommerceRecord[];
  sellers: CommerceRecord[];
  products: CommerceRecord[];
  productImages: CommerceRecord[];
  orders: CommerceRecord[];
  orderItems: CommerceRecord[];
  inquiries: CommerceRecord[];
  disputes: CommerceRecord[];
  paymentIntents: CommerceRecord[];
  paymentEvents: CommerceRecord[];
  financialLedger: CommerceRecord[];
  refunds: CommerceRecord[];
  financialDisputes: CommerceRecord[];
  monetizationSettings: CommerceRecord | null;
  creatorApplications: CommerceRecord[];
  adNetworkSettings: CommerceRecord | null;
  adPlacements: CommerceRecord[];
  adCampaigns: CommerceRecord[];
  adEvents: CommerceRecord[];
  adConsents: CommerceRecord[];
};

const globalStore = globalThis as typeof globalThis & { __novaCommerceStore?: CommerceState };

function emptyState(): CommerceState {
  return {
    creators: [],
    creatorSubscriptions: [],
    creatorLedger: [],
    creatorPayouts: [],
    businesses: [],
    businessMembers: [],
    businessFollowers: [],
    businessPosts: [],
    sellers: [],
    products: [],
    productImages: [],
    orders: [],
    orderItems: [],
    inquiries: [],
    disputes: [],
    paymentIntents: [],
    paymentEvents: [],
    financialLedger: [],
    refunds: [],
    financialDisputes: [],
    monetizationSettings: null,
    creatorApplications: [],
    adNetworkSettings: null,
    adPlacements: [],
    adCampaigns: [],
    adEvents: [],
    adConsents: [],
  };
}

if (!globalStore.__novaCommerceStore) globalStore.__novaCommerceStore = emptyState();

export const commerceStore = {
  get state() {
    if (env.NODE_ENV === 'production') throw new Error('In-memory commerce storage is disabled in production.');
    return globalStore.__novaCommerceStore!;
  },
  clear() {
    if (env.NODE_ENV === 'production') throw new Error('In-memory commerce storage is disabled in production.');
    globalStore.__novaCommerceStore = emptyState();
  },
};