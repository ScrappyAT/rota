import { SettingsValues } from '@rota/shared';
const minuteOfDay = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
/** UTC scanning handles skipped/repeated wall-clock times without guessing a DST offset. */
export const nextPermittedDelivery = (settings: Pick<SettingsValues, 'quietHours' | 'timeZone'>, now: Date): Date => {
  const { quietHours, timeZone } = settings;
  if (!quietHours.enabled)
    return now;
  const start = minuteOfDay(quietHours.start), end = minuteOfDay(quietHours.end);
  if (start === end)
    throw new Error('Invalid all-day quiet interval');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const quiet = (time: Date) => {
    const parts = formatter.formatToParts(time);
    const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  };
  if (!quiet(now))
    return now;
  for (let time = Math.floor(now.getTime() / 60000) * 60000 + 60000, i = 0;i < 48 * 60;i++, time += 60000) {
    const candidate = new Date(time);
    if (!quiet(candidate))
      return candidate;
  }
  throw new Error('No permitted notification window in 48 hours');
};
