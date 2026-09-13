import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses';

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface MailAdapter {
  send(message: MailMessage): Promise<void>;
}

export class MemoryMailAdapter implements MailAdapter {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push({ ...message });
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export interface SesMailAdapterOptions {
  client: SESClient;
  fromAddress: string;
}

export class SesMailAdapter implements MailAdapter {
  private readonly client: SESClient;
  private readonly fromAddress: string;

  constructor(options: SesMailAdapterOptions) {
    this.client = options.client;
    this.fromAddress = options.fromAddress;
  }

  async send(message: MailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        Source: this.fromAddress,
        Destination: { ToAddresses: [message.to] },
        Message: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: message.body, Charset: 'UTF-8' } },
        },
      }),
    );
  }
}

export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}
