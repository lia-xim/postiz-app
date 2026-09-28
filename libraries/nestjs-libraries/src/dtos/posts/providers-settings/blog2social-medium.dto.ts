import { IsDefined, IsString, MinLength } from 'class-validator';

export class Blog2SocialMediumDto {
  @IsString()
  @IsDefined()
  @MinLength(2)
  title: string;
}
