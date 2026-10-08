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
