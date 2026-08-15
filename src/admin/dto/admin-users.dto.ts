import { IsEmail, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export const ACCOUNT_STATUSES = ['ACTIVE', 'RESTRICTED', 'BLOCKED'] as const;

/** Query for the paginated admin user list. */
export class AdminUsersQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}

export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Display name cannot be empty' })
  @MaxLength(60)
  displayName?: string;

  // Normalised the same way registration normalises it, so an admin edit can't
  // introduce a handle that registration would never have allowed.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MinLength(3, { message: 'Username must be at least 3 characters' })
  @MaxLength(20, { message: 'Username must be at most 20 characters' })
  @Matches(/^[a-z0-9_]+$/, {
    message: 'Username can only contain letters, numbers, and underscores',
  })
  username?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Please enter a valid email address' })
  email?: string;
}

export class SetAccountStatusDto {
  @IsIn(ACCOUNT_STATUSES, { message: 'Unsupported account status' })
  status: (typeof ACCOUNT_STATUSES)[number];

  /** Shown back to the user, so they know why. Ignored when reinstating. */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}
