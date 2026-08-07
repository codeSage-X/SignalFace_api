import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { InviteAdminDto } from './dto/invite-admin.dto';
import { CreateSignalDto } from './dto/create-signal.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('invite')
  @HttpCode(HttpStatus.OK)
  inviteAdmin(@Body() dto: InviteAdminDto) {
    return this.adminService.inviteAdmin(dto);
  }

  @Get('overview')
  getOverview() {
    return this.adminService.getOverview();
  }

  @Get('users')
  getUsers() {
    return this.adminService.getUsers();
  }

  @Get('signals')
  getSignals() {
    return this.adminService.getSignals();
  }

  @Post('signals')
  @HttpCode(HttpStatus.CREATED)
  createSignal(@Body() dto: CreateSignalDto) {
    return this.adminService.createSignal(dto);
  }
}
