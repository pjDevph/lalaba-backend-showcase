import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly resend: Resend | null;
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY is not set. Email sending is disabled.');
      this.resend = null;
    } else {
      this.resend = new Resend(apiKey);
    }
  }

  async sendStaffInvite(params: {
    to: string;
    firstName: string;
    resetLink: string;
  }): Promise<void> {
    const { to, firstName, resetLink } = params;

    if (!this.resend) {
      this.logger.warn(
        `Email sending is disabled; skipping staff invite to ${to}.`,
      );
      return;
    }

    const { error } = await this.resend.emails.send({
      from: 'Lalaba <onboarding@resend.dev>',
      to,
      subject: 'You have been added as a staff member on Lalaba',
      html: `
        <p>Hi ${firstName},</p>
        <p>Your Lalaba staff account has been created.</p>
        <p>Click the link below to set your password and get started:</p>
        <p><a href="${resetLink}">Set My Password</a></p>
        <p>This link expires in 1 hour. If it expires, ask your manager to resend it.</p>
        <p>— The Lalaba Team</p>
      `,
    });

    if (error) {
      this.logger.error(
        `Failed to send staff invite to ${to}: ${error.message}`,
      );
    }
  }
}
