export const Roles = {
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
} as const;

export type Role = typeof Roles[keyof typeof Roles];
