import {
  IsEmail,
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  Matches,
  IsDateString,
  IsIn,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  firstName: string;

  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  lastName: string;

  // Normalised here, before validation, so the value the rest of the request
  // sees is already the one that will be stored. Doing it only at write time is
  // what let a mixed-case name slip past the "already taken" check.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MinLength(3, { message: 'Username must be at least 3 characters' })
  @MaxLength(20, { message: 'Username must be at most 20 characters' })
  @Matches(/^[a-z0-9_]+$/, {
    message: 'Username can only contain letters, numbers, and underscores',
  })
  username: string;

  @IsDateString({}, { message: 'Date of birth must be a valid date' })
  dateOfBirth: string;

  @IsString()
  @IsIn(['male', 'female', 'non-binary', 'prefer-not-to-say'], {
    message: 'Invalid gender value',
  })
  gender: string;

  @IsEmail({}, { message: 'Please enter a valid email address' })
  email: string;

  // Length only — see the note on the client schema. Must stay in step with it,
  // or the form accepts a password the API then rejects.
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password: string;

  /**
   * Whoever invited them. Optional, and a code that matches nobody is ignored
   * rather than rejected — a bad invite link should not block a sign-up.
   */
  @IsOptional()
  @IsString()
  referralCode?: string;
}
