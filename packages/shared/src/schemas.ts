import { z } from 'zod';
import { Roles, ShiftStatus, SwapStatus } from './roles';

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

const isoDate = () => z.string().datetime().or(z.date());

export const ShiftSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  createdBy: z.string().uuid(),
  title: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  startsAt: isoDate(),
  endsAt: isoDate(),
  status: z.nativeEnum(ShiftStatus),
  createdAt: isoDate(),
  updatedAt: isoDate(),
});

export type Shift = z.infer<typeof ShiftSchema>;

export const ShiftAssignmentSchema = z.object({
  shiftId: z.string().uuid(),
  userId: z.string().uuid(),
  assignedBy: z.string().uuid(),
  createdAt: isoDate(),
});

export type ShiftAssignment = z.infer<typeof ShiftAssignmentSchema>;

export const SwapRequestSchema = z.object({
  id: z.string().uuid(),
  shiftId: z.string().uuid(),
  requestedBy: z.string().uuid(),
  offeredTo: z.string().uuid().nullable(),
  status: z.nativeEnum(SwapStatus),
  reason: z.string().max(1000).nullable().optional(),
  reviewedBy: z.string().uuid().nullable().optional(),
  reviewedAt: isoDate().nullable().optional(),
  createdAt: isoDate(),
});

export type SwapRequest = z.infer<typeof SwapRequestSchema>;

export const ActivityEventSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDate(),
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const CreateShiftSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    description: z.string().max(2000).optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    assigneeIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .refine((d) => new Date(d.endsAt).getTime() > new Date(d.startsAt).getTime(), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type CreateShiftInput = z.infer<typeof CreateShiftSchema>;

export const UpdateShiftSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    status: z.nativeEnum(ShiftStatus).optional(),
  })
  .refine(
    (d) =>
      !(d.startsAt && d.endsAt) ||
      new Date(d.endsAt).getTime() > new Date(d.startsAt).getTime(),
    {
      message: 'endsAt must be after startsAt',
      path: ['endsAt'],
    }
  );

export type UpdateShiftInput = z.infer<typeof UpdateShiftSchema>;

export const AssignShiftSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(50),
});

export type AssignShiftInput = z.infer<typeof AssignShiftSchema>;

export const CreateSwapSchema = z.object({
  offeredTo: z.string().uuid().nullable().optional(),
  reason: z.string().max(1000).optional(),
});

export type CreateSwapInput = z.infer<typeof CreateSwapSchema>;

export const SwapReasonSchema = z.object({
  reason: z.string().max(1000).optional(),
});

export type SwapReasonInput = z.infer<typeof SwapReasonSchema>;

export const PaginatedResponseSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

