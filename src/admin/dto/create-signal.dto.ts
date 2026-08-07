import { IsNumber, IsPositive, IsString, Length } from 'class-validator';

export class CreateSignalDto {
  @IsString()
  @Length(1, 80, { message: 'Title is required' })
  title: string;

  @IsNumber()
  @IsPositive({ message: 'Worth must be a positive number' })
  worth: number;
}
