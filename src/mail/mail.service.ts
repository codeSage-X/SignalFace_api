import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { EMAIL_OTP_TTL_MINUTES, PASSWORD_RESET_OTP_TTL_MINUTES } from '@signal-face/shared';

type OtpPurpose = 'verify' | 'reset' | 'invite';

const OTP_EMAIL_COPY: Record<OtpPurpose, { subject: string; heading: string; body: string; ttlMinutes: number }> = {
  verify: {
    subject: 'Verify your Signal Face email',
    heading: 'Confirm your email address',
    body: 'Use the code below. It expires in {ttl} minutes.',
    ttlMinutes: EMAIL_OTP_TTL_MINUTES,
  },
  reset: {
    subject: 'Reset your Signal Face password',
    heading: 'Reset your password',
    body: 'Use the code below. It expires in {ttl} minutes.',
    ttlMinutes: PASSWORD_RESET_OTP_TTL_MINUTES,
  },
  invite: {
    subject: "You've been invited to Signal Face Admin",
    heading: 'Set up your admin account',
    body: 'Use the code below to set your password and finish setting up your admin account. It expires in {ttl} minutes.',
    ttlMinutes: PASSWORD_RESET_OTP_TTL_MINUTES,
  },
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  async sendOtpEmail(to: string, otp: string, purpose: OtpPurpose) {
    const { subject, heading, body, ttlMinutes } = OTP_EMAIL_COPY[purpose];

    try {
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM ?? 'Signal Face <no-reply@signalface.app>',
        to,
        subject,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2>${heading}</h2>
            <p>${body.replace('{ttl}', String(ttlMinutes))}</p>
            <p style="font-size:32px;font-weight:700;letter-spacing:8px">${otp}</p>
            <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error(`Failed to send ${purpose} email to ${to}: ${(err as Error).message}`);
      // Dev fallback so the flow is testable before real SMTP credentials are configured.
      this.logger.warn(`[DEV FALLBACK] ${purpose} OTP for ${to}: ${otp}`);
    }
  }
}
