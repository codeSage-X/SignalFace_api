import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RewardsService } from './rewards.service';
import { AdminRewardsController, RewardsController } from './rewards.controller';

@Module({
  // AuthModule for the JWT guards; exported so AuthService can pay the referral
  // bonus at the moment an invited account verifies.
  imports: [forwardRef(() => AuthModule)],
  controllers: [RewardsController, AdminRewardsController],
  providers: [RewardsService],
  exports: [RewardsService],
})
export class RewardsModule {}
