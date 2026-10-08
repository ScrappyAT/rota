import { z } from 'zod';
import { Roles } from './roles';

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  createdAt: z.string().datetime().or(z.date()),
});

export type User = z.infer<typeof UserSchema>;

export const TeamSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  ownerId: z.string().uuid(),
  createdAt: z.string().datetime().or(z.date()),
});

export type Team = z.infer<typeof TeamSchema>;

export const RegisterSchema = z.object({
  email: z.string().email().transform(e => e.toLowerCase()),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

export const LoginSchema = z.object({
  email: z.string().email().transform(e => e.toLowerCase()),
  password: z.string(),
});

export const TeamMembershipSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.nativeEnum(Roles),
});

export const InvitationSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(Roles),
  inviterId: z.string().uuid(),
  expiresAt: z.string().datetime().or(z.date()),
  acceptedAt: z.string().datetime().or(z.date()).nullable().optional(),
});

