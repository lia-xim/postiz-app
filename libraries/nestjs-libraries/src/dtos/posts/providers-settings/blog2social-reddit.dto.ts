import { IsDefined, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class Blog2SocialRedditDto {
  @IsString()
  @IsDefined()
  @MinLength(2)
  @MaxLength(300)
  title: string;

  @IsString()
  @IsDefined()
  @Matches(/^https:\/\/[^\s]+$/)
  url: string;
}
