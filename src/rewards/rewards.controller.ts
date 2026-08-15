import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveAccountGuard } from '../auth/guards/active-account.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RewardsService } from './rewards.service';
import { CreateRewardDto, UpdateRewardDto } from './dto/reward.dto';

@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  /** What the viewer can claim, and whether each is available right now. */
  @Get()
  @UseGuards(JwtAuthGuard)
  list(@Req() req: any) {
    return this.rewardsService.listForUser(req.user.sub);
  }

  @Get('referrals')
  @UseGuards(JwtAuthGuard)
  referrals(@Req() req: any) {
    return this.rewardsService.referralSummary(req.user.sub);
  }

  // Claiming moves money, so an account under review cannot do it.
  @Post(':id/claim')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.OK)
  claim(@Req() req: any, @Param('id') id: string) {
    return this.rewardsService.claim(req.user.sub, id);
  }
}

/**
 * Admin-only management. Separate controller rather than extra guards on the
 * one above, so a route can never be added here without the role check.
 */
@Controller('admin/rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminRewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @Get()
  list() {
    return this.rewardsService.listAll();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateRewardDto) {
    return this.rewardsService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRewardDto) {
    return this.rewardsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.rewardsService.remove(id);
  }
}
