import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [WalletService, JwtAuthGuard],
})
export class WalletModule {}
