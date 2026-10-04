import { PermanentDeliveryError, type Channel, type EmailMessage } from './channel.js';
import { MockEmailChannel } from './mock-email-channel.js';

export class ResendEmailChannel implements Channel {
  readonly name = 'resend';

  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json',
        ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, html: message.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return;
    const error = `Resend email request failed with status ${response.status}`;
    // 4xx means our request is wrong, so retrying cannot help; 408/429 and 5xx are transient.
    if (response.status < 500 && response.status !== 408 && response.status !== 429) throw new PermanentDeliveryError(error);
    throw new Error(error);
  }
}

export function createEmailChannel(env: NodeJS.ProcessEnv = process.env): Channel {
  if (!env.EMAIL_PROVIDER || env.EMAIL_PROVIDER === 'mock') return new MockEmailChannel();
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY && env.EMAIL_FROM) {
    return new ResendEmailChannel(env.RESEND_API_KEY, env.EMAIL_FROM);
  }
  throw new Error('Resend requires EMAIL_PROVIDER=resend, RESEND_API_KEY, and EMAIL_FROM');
}
