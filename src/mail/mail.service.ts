import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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

  /**
   * Resend's HTTPS API when a key is present, SMTP otherwise.
   *
   * Render's free instances block outbound traffic to ports 25/465/587, so SMTP
   * cannot leave the box no matter how correct the credentials are. HTTPS is not
   * blocked, which is why the API path is preferred wherever it's configured.
   */
  private async deliver(to: string, subject: string, html: string) {
    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
      await this.transporter.sendMail({ from: this.sender(), to, subject, html });
      return;
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.sender(), to, subject, html }),
    });

    // A non-2xx here is a real rejection (unverified sender domain, bad key,
    // rate limit) and the body explains which — worth keeping in the message.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend returned ${res.status}: ${detail.slice(0, 300)}`);
    }
  }

  /** Resend only accepts senders on a verified domain; SMTP_FROM is a Gmail address. */
  private sender(): string {
    return (
      process.env.MAIL_FROM ??
      (process.env.RESEND_API_KEY
        ? 'Signal Face <no-reply@signalface.com>'
        : (process.env.SMTP_FROM ?? 'Signal Face <no-reply@signalface.app>'))
    );
  }

  async sendOtpEmail(to: string, otp: string, purpose: OtpPurpose) {
    const { subject, heading, body, ttlMinutes } = OTP_EMAIL_COPY[purpose];

    try {
      await this.deliver(
        to,
        subject,
        `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2>${heading}</h2>
            <p>${body.replace('{ttl}', String(ttlMinutes))}</p>
            <p style="font-size:32px;font-weight:700;letter-spacing:8px">${otp}</p>
            <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
      );
    } catch (err) {
      this.logger.error(`Failed to send ${purpose} email to ${to}: ${(err as Error).message}`);

      // The fallback prints a live credential, so it stays out of production logs.
      // A reset OTP in a log anyone on the team can read is an account takeover
      // waiting to happen — and when SMTP is broken rather than merely absent,
      // *every* code lands there.
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn(`[DEV FALLBACK] ${purpose} OTP for ${to}: ${otp}`);
        return;
      }

      // Swallowing this is what made the Render SMTP block invisible: registration
      // returned success and sent people to an OTP screen no code could ever reach.
      // The caller stores the OTP before sending, so a resend issues a fresh one.
      throw new ServiceUnavailableException(
        "We couldn't send your code right now. Please try again in a moment.",
      );
    }
  }
}
