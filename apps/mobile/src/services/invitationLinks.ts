import { z } from 'zod';
import type { IAuthStorage } from '../storage/authStorage';

const PendingSchema = z.object({ code: z.string().regex(/^\d{6}$/), email: z.string().email().optional(), expiresAt: z.number().finite(), acceptedTeamId: z.string().uuid().optional() });
export type PendingInvitation = z.infer<typeof PendingSchema>;
const KEY = 'pendingInvitationV1';
export function invitationLink(code: string, email: string, expiresAt: string): string {
  const value = PendingSchema.parse({ code, email, expiresAt: Date.parse(expiresAt) });
  return `rota:///teams/accept?${new URLSearchParams({ code: value.code, email: value.email!, expiresAt: String(value.expiresAt) })}`;
}
export function invitationFromParams(params: { code?: unknown; email?: unknown; expiresAt?: unknown }, now = Date.now()): PendingInvitation | null {
  const parsed = PendingSchema.safeParse({ code: params.code, email: params.email, expiresAt: params.expiresAt === undefined ? now + 15 * 60_000 : Number(params.expiresAt) });
  return parsed.success ? parsed.data : null;
}
export const saveInvitation = (store: IAuthStorage, value: PendingInvitation) => store.setItemAsync(KEY, JSON.stringify(PendingSchema.parse(value)));
export const clearInvitation = (store: IAuthStorage) => store.deleteItemAsync(KEY);
export async function readInvitation(store: IAuthStorage): Promise<PendingInvitation | null> {
  try { const raw = await store.getItemAsync(KEY); return raw ? PendingSchema.parse(JSON.parse(raw)) : null; } catch { return null; }
}
export async function postAuthDestination(store: IAuthStorage): Promise<'/teams/accept' | '/'> {
  return await readInvitation(store) ? '/teams/accept' : '/';
}
/** Persist acceptance before refreshing, so a lost refresh never redeems twice. */
export async function redeemAndSelect(store: IAuthStorage, value: PendingInvitation, api: {
  redeem: (code: string) => Promise<{ teamId: string }>;
  refresh: () => Promise<void>;
  select: (id: string) => Promise<void>;
}) {
  let teamId = value.acceptedTeamId;
  if (!teamId) {
    teamId = z.string().uuid().parse((await api.redeem(value.code)).teamId);
    await saveInvitation(store, { ...value, acceptedTeamId: teamId });
  }
  await api.refresh();
  await api.select(teamId);
  await clearInvitation(store);
  return teamId;
}
