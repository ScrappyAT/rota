import { z } from 'zod';
export const QuietHoursSchema = z.object({
  enabled: z.boolean(), start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
}).strict().refine(v => !v.enabled || v.start !== v.end, 'Enabled quiet hours need different start and end times');
export const TimeZoneSchema = z.string().max(100).refine(value => {
  if (value !== 'UTC' && !value.includes('/'))
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  }
  catch {
    return false;
  }
}, 'Use a valid IANA time zone, such as Africa/Lagos');
export const SettingsValuesSchema = z.object({
  quietHours: QuietHoursSchema,
  timeZone: TimeZoneSchema,
  notificationCategories: z.object({ shifts: z.boolean(), swaps: z.boolean(), billing: z.boolean() }).strict(),
  language: z.string().min(2).max(35).refine(value => {
    try {
      return Intl.getCanonicalLocales(value).length === 1;
    }
    catch {
      return false;
    }
  }, 'Invalid language tag'),
  theme: z.enum(['system', 'light', 'dark']),
}).strict();
export const NotificationTypesSchema = z.object({ shiftAssigned: z.boolean(), swapRequested: z.boolean(), swapApproved: z.boolean(), swapRejected: z.boolean() }).strict();
export const SettingsPatchSchema = SettingsValuesSchema.omit({ notificationCategories: true }).partial().extend({
  notificationCategories: SettingsValuesSchema.shape.notificationCategories.partial().optional(),
  notificationTypes: NotificationTypesSchema.partial().optional(),
}).strict().refine(v => Object.entries(v).some(([, value]) => value !== undefined && (typeof value !== 'object' || Object.keys(value).length > 0)), 'Provide at least one setting');
export type SettingsValues = z.infer<typeof SettingsValuesSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export interface UserSettings extends SettingsValues {
  notificationTypes: z.infer<typeof NotificationTypesSchema>;
  updatedAt: string;
  fieldUpdatedAt: Record<string, string>;
}
export const DEFAULT_SETTINGS: SettingsValues = { quietHours: { enabled: false, start: '22:00', end: '06:00' }, timeZone: 'UTC', notificationCategories: { shifts: true, swaps: true, billing: true }, language: 'en', theme: 'system' };
export const mergeSettings = (current: UserSettings, patch: SettingsPatch): UserSettings => ({
  ...current, ...patch,
  notificationCategories: { ...current.notificationCategories, ...patch.notificationCategories },
  notificationTypes: { ...current.notificationTypes, ...patch.notificationTypes },
});
/** The same optimistic/rollback/foreground coordinator is used by the mobile provider and tests. */
export class SettingsController {
  private listeners = new Set<() => void>();
  private active = true;
  private version = 0;
  state: {
    settings: UserSettings | null;
    saving: boolean;
    loading: boolean;
    error: string | null;
  } = { settings: null, saving: false, loading: true, error: null };
  constructor(private readonly api: {
    get: () => Promise<UserSettings>;
    patch: (patch: SettingsPatch) => Promise<UserSettings>;
  }) { }
  subscribe(listener: () => void): () => void { this.active = true; this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void {
    if (this.active)
      this.listeners.forEach(listener => listener());
  }
  dispose(): void { this.active = false; this.version++; this.listeners.clear(); }
  async refresh(): Promise<void> {
    if (!this.active || this.state.saving)
      return;
    const version = ++this.version;
    try {
      const settings = await this.api.get();
      if (this.active && version === this.version)
        this.state = { settings, saving: false, loading: false, error: null };
    }
    catch {
      if (this.active && version === this.version)
        this.state = { ...this.state, loading: false, error: 'Could not refresh settings' };
    }
    this.emit();
  }
  async update(patch: SettingsPatch): Promise<void> {
    if (!this.active || !this.state.settings || this.state.saving)
      throw new Error('Settings are not ready for another change');
    const previous = this.state.settings;
    const version = ++this.version;
    this.state = { ...this.state, settings: mergeSettings(previous, patch), saving: true, error: null };
    this.emit();
    try {
      const settings = await this.api.patch(patch);
      if (this.active && version === this.version)
        this.state = { settings, saving: false, loading: false, error: null };
    }
    catch (error) {
      if (this.active && version === this.version)
        this.state = { settings: previous, saving: false, loading: false, error: 'Could not save settings; your change was rolled back' };
      throw error;
    }
    finally {
      this.emit();
    }
  }
}
