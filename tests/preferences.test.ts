import { describe, expect, it } from 'vitest';
import { preferenceSchema, quietUntil, resolvePreference, type Preference } from '../src/preferences.js';

const pref = (p: Partial<Preference>): Preference => preferenceSchema.parse({ channel: '*', type: '*', ...p });
const night = { start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' };

describe('resolvePreference', () => {
  it('defaults to enabled with no quiet hours', () => {
    expect(resolvePreference([], 'email', 'x')).toEqual({ enabled: true, quietHours: null });
  });

  it('lets the most specific row decide enabled', () => {
    const prefs = [pref({ channel: 'email', enabled: false }), pref({ channel: 'email', type: 'alert', enabled: true })];
    expect(resolvePreference(prefs, 'email', 'alert').enabled).toBe(true);
    expect(resolvePreference(prefs, 'email', 'promo').enabled).toBe(false);
    expect(resolvePreference(prefs, 'in_app', 'promo').enabled).toBe(true);
  });

  it('takes quiet hours from the most specific row that defines them', () => {
    const prefs = [pref({ type: '*', quietHours: night }), pref({ channel: 'email', type: 'alert', enabled: true })];
    expect(resolvePreference(prefs, 'email', 'alert').quietHours).toEqual(night);
  });
});

describe('quietUntil', () => {
  // 2026-01-01T17:00:00Z is 22:30 in Asia/Kolkata (UTC+5:30).
  it('returns the end of a window that wraps midnight', () => {
    expect(quietUntil(night, new Date('2026-01-01T17:00:00Z'))?.toISOString()).toBe('2026-01-02T01:30:00.000Z'); // 07:00 IST
  });

  it('is null outside the window and for an empty window', () => {
    expect(quietUntil(night, new Date('2026-01-01T09:00:00Z'))).toBeNull(); // 14:30 IST
    expect(quietUntil({ ...night, start: '09:00', end: '09:00' }, new Date('2026-01-01T09:00:00Z'))).toBeNull();
  });

  it('handles a same-day window and the exact boundaries', () => {
    const lunch = { start: '12:00', end: '13:00', timezone: 'UTC' };
    expect(quietUntil(lunch, new Date('2026-01-01T12:00:00Z'))?.toISOString()).toBe('2026-01-01T13:00:00.000Z');
    expect(quietUntil(lunch, new Date('2026-01-01T13:00:00Z'))).toBeNull();
  });

  it('rejects bad input', () => {
    expect(() => preferenceSchema.parse({ channel: 'sms', type: 'x' })).toThrow();
    expect(() => preferenceSchema.parse({ channel: 'email', type: 'x', quietHours: { ...night, timezone: 'Mars/Base' } })).toThrow();
    expect(() => preferenceSchema.parse({ channel: 'email', type: 'x', quietHours: { ...night, start: '25:00' } })).toThrow();
  });
});
