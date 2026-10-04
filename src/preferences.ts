import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const timezone = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}, 'Unknown IANA time zone');

export const quietHoursSchema = z.object({ start: hhmm, end: hhmm, timezone }).strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;

// `*` in channel or type is a wildcard row.
export const preferenceSchema = z.object({
  channel: z.enum(['email', 'in_app', '*']),
  type: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  quietHours: quietHoursSchema.nullable().default(null),
}).strict();
export type Preference = z.infer<typeof preferenceSchema>;

// The most specific matching row decides `enabled` (exact channel beats exact type beats wildcards), while quiet hours come from the
// most specific row that defines them, so "email opt-out for marketing" and "quiet hours for everything" compose.
export function resolvePreference(prefs: Preference[], channel: string, type: string): { enabled: boolean; quietHours: QuietHours | null } {
  const matches = prefs.flatMap((p) => {
    if ((p.channel !== channel && p.channel !== '*') || (p.type !== type && p.type !== '*')) return [];
    return [{ p, rank: (p.channel === channel ? 2 : 0) + (p.type === type ? 1 : 0) }];
  }).sort((a, b) => b.rank - a.rank);
  return { enabled: matches[0]?.p.enabled ?? true, quietHours: matches.find((m) => m.p.quietHours)?.p.quietHours ?? null };
}

const minutes = (hhmmValue: string) => Number(hhmmValue.slice(0, 2)) * 60 + Number(hhmmValue.slice(3));

// Returns when the quiet window ends if `now` is inside it (handles windows that wrap midnight), else null.
// ponytail: computed from the current local clock, so a DST change inside the window shifts the end by up to an hour.
export function quietUntil(quiet: QuietHours, now: Date): Date | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: quiet.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, Number(p.value)])) as Record<string, number>;
  const current = parts.hour! * 60 + parts.minute!;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return null;
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  if (!inside) return null;
  const remainingSeconds = (((end - current + 1440) % 1440) * 60) - parts.second!;
  return new Date(now.getTime() - (now.getTime() % 1000) + remainingSeconds * 1000);
}
