export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  // Stable per notification and channel, so a re-send after a crash is deduplicated by providers that support it.
  idempotencyKey?: string;
}

// Retrying cannot help (bad recipient, missing template, provider 4xx): go straight to the dead-letter set.
export class PermanentDeliveryError extends Error {}

export interface Channel {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
