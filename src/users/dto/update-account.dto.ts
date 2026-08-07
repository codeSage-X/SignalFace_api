import { IsOptional, IsEmail, IsString, Length, Matches } from 'class-validator';

export class UpdateAccountDto {
  @IsOptional()
  @IsEmail({}, { message: 'Please enter a valid email address' })
  email?: string;

  @IsOptional()
  @IsString()
  @Length(3, 20, { message: 'Username must be between 3 and 20 characters' })
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'Letters, numbers and underscores only' })
  username?: string;

  @IsOptional()
  @IsString()
  @Length(1, 60, { message: 'Display name is required' })
  displayName?: string;
}
