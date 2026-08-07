import { IsEmail, IsString, Length } from 'class-validator';

export class InviteAdminDto {
  @IsEmail({}, { message: 'Please enter a valid email address' })
  email: string;

  @IsString()
  @Length(1, 60, { message: 'Display name is required' })
  displayName: string;
}
