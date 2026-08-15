import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export const REWARD_TYPES = ['SIGNUP_BONUS', 'REFERRAL_BONUS', 'ONE_TIME', 'RECURRING'] as const;

export class CreateRewardDto {
  @IsString()
  @MinLength(1, { message: 'A reward needs a name' })
  @MaxLength(60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsIn(REWARD_TYPES, { message: 'Unsupported reward type' })
  type: (typeof REWARD_TYPES)[number];

  // Money-like, so it is carried as a number here and stored as Decimal.
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'Amount must be a number' })
  @Min(0, { message: 'Amount cannot be negative' })
  amount: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsISO8601({}, { message: 'Start date must be a valid date' })
  startsAt?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'End date must be a valid date' })
  endsAt?: string;

  /** Required for RECURRING — enforced in the service, which sees both fields. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'Cooldown must be at least one hour' })
  cooldownHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxClaims?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxPerUser?: number;
}

/** Every field optional: the admin form saves whichever ones it changed. */
export class UpdateRewardDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'A reward needs a name' })
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsOptional()
  @IsIn(REWARD_TYPES, { message: 'Unsupported reward type' })
  type?: (typeof REWARD_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'Amount must be a number' })
  @Min(0, { message: 'Amount cannot be negative' })
  amount?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsISO8601({}, { message: 'Start date must be a valid date' })
  startsAt?: string | null;

  @IsOptional()
  @IsISO8601({}, { message: 'End date must be a valid date' })
  endsAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'Cooldown must be at least one hour' })
  cooldownHours?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxClaims?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxPerUser?: number | null;
}
