export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface Channel {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
