export const Roles = {
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
} as const;

export type Role = typeof Roles[keyof typeof Roles];

export const ShiftStatus = {
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED',
} as const;

export type ShiftStatus = typeof ShiftStatus[keyof typeof ShiftStatus];

export const SwapStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type SwapStatus = typeof SwapStatus[keyof typeof SwapStatus];

export const SubscriptionStatus = {
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type SubscriptionStatus = typeof SubscriptionStatus[keyof typeof SubscriptionStatus];

export const SubscriptionChangeType = {
  PLAN_UPGRADE: 'PLAN_UPGRADE',
  PLAN_DOWNGRADE: 'PLAN_DOWNGRADE',
  ADD_SEATS: 'ADD_SEATS',
  REDUCE_SEATS: 'REDUCE_SEATS',
  RENEWAL: 'RENEWAL',
} as const;

export type SubscriptionChangeType =
  typeof SubscriptionChangeType[keyof typeof SubscriptionChangeType];

export const SubscriptionChangeStatus = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  FAILED: 'FAILED',
} as const;

export type SubscriptionChangeStatus =
  typeof SubscriptionChangeStatus[keyof typeof SubscriptionChangeStatus];

export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCESSFUL: 'SUCCESSFUL',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type PaymentStatus = typeof PaymentStatus[keyof typeof PaymentStatus];

export const InvoiceStatus = {
  OUTSTANDING: 'OUTSTANDING',
  PAID: 'PAID',
  REFUNDED: 'REFUNDED',
} as const;

export type InvoiceStatus = typeof InvoiceStatus[keyof typeof InvoiceStatus];
