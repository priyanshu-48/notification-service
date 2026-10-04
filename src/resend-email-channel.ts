import type { Channel, EmailMessage } from './channel.js';
import { MockEmailChannel } from './mock-email-channel.js';

export class ResendEmailChannel implements Channel {
  readonly name = 'resend';

  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, html: message.html }),
    });
    if (!response.ok) throw new Error(`Resend email request failed with status ${response.status}`);
  }
}

export function createEmailChannel(env: NodeJS.ProcessEnv = process.env): Channel {
  if (!env.EMAIL_PROVIDER || env.EMAIL_PROVIDER === 'mock') return new MockEmailChannel();
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY && env.EMAIL_FROM) {
    return new ResendEmailChannel(env.RESEND_API_KEY, env.EMAIL_FROM);
  }
  throw new Error('Resend requires EMAIL_PROVIDER=resend, RESEND_API_KEY, and EMAIL_FROM');
}
