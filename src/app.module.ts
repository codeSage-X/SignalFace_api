import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PostsModule } from './posts/posts.module';
import { RealmsModule } from './realms/realms.module';
import { SignalsModule } from './signals/signals.module';
import { MarketModule } from './market/market.module';
import { WalletModule } from './wallet/wallet.module';
import { AdminModule } from './admin/admin.module';
import { RewardsModule } from './rewards/rewards.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    PrismaModule,
    AuthModule,
    UsersModule,
    PostsModule,
    RealmsModule,
    SignalsModule,
    MarketModule,
    WalletModule,
    AdminModule,
    RewardsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
