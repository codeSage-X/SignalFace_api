import { IsEmail } from 'class-validator';

export class ResendOtpDto {
  @IsEmail({}, { message: 'Please enter a valid email address' })
  email: string;
}
