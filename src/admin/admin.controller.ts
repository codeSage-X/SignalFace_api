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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { InviteAdminDto } from './dto/invite-admin.dto';
import { CreateSignalDto } from './dto/create-signal.dto';
import {
  AdminUsersQueryDto,
  SetAccountStatusDto,
  UpdateAdminUserDto,
} from './dto/admin-users.dto';

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
  getUsers(@Query() query: AdminUsersQueryDto) {
    return this.adminService.getUsers(query);
  }

  @Patch('users/:id')
  updateUser(@Param('id') id: string, @Body() dto: UpdateAdminUserDto) {
    return this.adminService.updateUser(id, dto);
  }

  // Restrict, block or reinstate. The acting admin is passed through so the
  // service can refuse self-targeting.
  @Patch('users/:id/status')
  setUserStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: SetAccountStatusDto,
  ) {
    return this.adminService.setUserStatus(id, dto, req.user.sub);
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.OK)
  deleteUser(@Req() req: any, @Param('id') id: string) {
    return this.adminService.deleteUser(id, req.user.sub);
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
