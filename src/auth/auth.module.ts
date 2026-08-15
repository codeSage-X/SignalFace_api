import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ACCESS_TOKEN_TTL } from '@signal-face/shared';
import { RewardsModule } from '../rewards/rewards.module';
import { MailModule } from '../mail/mail.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'fallback-dev-secret',
      signOptions: { expiresIn: ACCESS_TOKEN_TTL },
    }),
    MailModule,
    FirebaseModule,
    // Circular by nature: rewards needs these guards, auth needs rewards to pay
    // the referral bonus the moment an invited account verifies.
    forwardRef(() => RewardsModule),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
