import type { Channel, EmailMessage } from './channel.js';

export class MockEmailChannel implements Channel {
  readonly name = 'mock-email';
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
