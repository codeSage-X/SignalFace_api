import { IsEmail, IsString, Length } from 'class-validator';

export class VerifyResetOtpDto {
  @IsEmail({}, { message: 'Please enter a valid email address' })
  email: string;

  @IsString()
  @Length(6, 6, { message: 'Code must be 6 digits' })
  otp: string;
}
