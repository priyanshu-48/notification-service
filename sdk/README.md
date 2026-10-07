# notification-service-client

Zero-dependency TypeScript client for the notification service. Two pieces:

- **`NotificationClient`** runs on your **server** with a tenant API key: send notifications, manage users and preferences, mint stream tokens.
- **`NotificationStream`** runs in the **browser or extension**: live notifications over WebSocket, with the inbox replayed on connect and automatic reconnects.

Requires Node 20+ (Node 22+ for the stream without passing a `WebSocket` class) or any modern browser. Build with `npm run sdk:build` from the repo root.

> The API key is a secret. Never put it in a browser bundle or extension. The browser only ever gets a short-lived stream token that your backend mints.

## Server: send notifications

```ts
import { NotificationClient } from 'notification-service-client';

const notifications = new NotificationClient({ baseUrl: 'https://notifications.example.com', apiKey: process.env.NOTIFICATIONS_API_KEY! });

// Once per user (e.g. at registration). Safe to repeat.
await notifications.upsertUser('user-42', { email: 'sam@example.com' });

// Address users by your own id. In-app and email in one call; an idempotency key is generated for you.
await notifications.send({ externalUserId: 'user-42', type: 'limit', payload: { title: 'You have spent 40 minutes on YouTube today' }, channels: ['in_app', 'email'] });

// Several triggers collapse into one "N new ..." message within the window.
await notifications.send({ externalUserId: 'user-42', type: 'comment', payload: { title: 'Ann replied' }, digestKey: 'post-9', digestWindowSeconds: 600 });

// Dedupe across separate calls with your own key, e.g. a daily reminder that a retrying cron job may fire twice.
await notifications.send({ externalUserId: 'user-42', type: 'streak', payload: { title: '7 day streak!' } }, { idempotencyKey: 'streak:user-42:2026-01-01' });
```

### Retries and duplicates

`send` is safe to retry, so it does: network errors, timeouts, `429` (honouring `Retry-After`) and `502/503/504` are retried with exponential backoff and jitter (default 3 retries), always with the **same** idempotency key. If the service saved a notification but could not queue it (`503`), the retry returns the original instead of creating a second one, and `result.replayed` is `true`. Reads, `PUT` and `DELETE` are retried the same way. Calls that are not safe to repeat (stream tokens, template creation) are not retried. Other errors throw a `NotificationApiError` with `status`, `code` and `details`.

### Other calls

`deleteUser(externalUserId)` (erase a user and everything held about them; safe to repeat), `getNotification(id)` (status and every delivery attempt), `listNotifications({ status, limit, before })`, `listDeadLetters()`, `replayNotification(id)`, `getPreferences` / `setPreferences(externalUserId, [...])`, `getInbox`, `markRead`, `createTemplate` / `listTemplates`, `getStats(hours)`.

```ts
// Quiet hours delay instead of dropping; opt-outs skip a channel for a type.
await notifications.setPreferences('user-42', [
  { channel: '*', type: '*', quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' } },
  { channel: 'email', type: 'newsletter', enabled: false },
]);
```

## Browser or extension: live stream

Your backend exposes an endpoint that authenticates *your* user and returns `await notifications.createStreamToken(userId)`. The browser passes it to the stream:

```ts
import { NotificationStream } from 'notification-service-client';

const stream = new NotificationStream({
  url: 'wss://notifications.example.com/stream',
  getToken: async () => (await fetch('/api/notification-token')).json().then((t) => t.token), // called on every (re)connect
});

stream.on('inbox', (items) => render(items));            // replayed on every connect: everything delivered in-app, newest first
stream.on('notification', (item) => prepend(item));       // live pushes, already de-duplicated by id
stream.on('status', (s) => showConnection(s));            // 'connecting' | 'open' | 'closed'
stream.on('error', (e) => console.error(e));
stream.connect();

await stream.markRead(item.id);                           // resolves true once the server confirms
stream.close();
```

The stream reconnects with backoff and fetches a fresh token each time. If the server rejects the token three times in a row it stops and emits `error` rather than looping. An inbox item with `count > 1` is a digest ("3 new comments"). In a Manifest V3 extension, run the stream in a long-lived context (an offscreen document or the popup/page); service workers are suspended too aggressively to hold a socket.
