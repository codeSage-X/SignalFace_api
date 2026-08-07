import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { initializeApp, getApps, getApp, cert, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';

export interface FirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  provider: string;
}

@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App | null = null;

  // Lazy: the API must still boot (and serve email/password auth) when Firebase
  // credentials aren't configured, e.g. a local checkout without a service account.
  private getApp(): App {
    if (this.app) return this.app;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Env files store the PEM with literal \n sequences; restore the real newlines.
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.error('Firebase credentials are not configured');
      throw new UnauthorizedException('Google sign-in is not available right now');
    }

    this.app = getApps().length
      ? getApp()
      : initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });

    return this.app;
  }

  async verifyIdToken(idToken: string): Promise<FirebaseIdentity> {
    let decoded: DecodedIdToken;
    try {
      decoded = await getAuth(this.getApp()).verifyIdToken(idToken, true);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(`Rejected Firebase ID token: ${(err as Error).message}`);
      throw new UnauthorizedException('Could not verify your Google sign-in. Please try again.');
    }

    if (!decoded.email) {
      throw new UnauthorizedException('Your Google account has no email address attached');
    }

    // Google-issued emails are already verified by Google; anything else must say so itself.
    if (!decoded.email_verified) {
      throw new UnauthorizedException('Your Google account email is not verified');
    }

    return {
      uid: decoded.uid,
      email: decoded.email.toLowerCase(),
      emailVerified: Boolean(decoded.email_verified),
      name: (decoded.name as string | undefined) ?? null,
      picture: (decoded.picture as string | undefined) ?? null,
      provider: (decoded.firebase?.sign_in_provider as string | undefined) ?? 'google.com',
    };
  }
}
