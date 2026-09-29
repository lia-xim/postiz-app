import { IsUrl, ValidateIf } from 'class-validator';

export class Blog2SocialGmbDto {
  @ValidateIf((settings) => !!settings.url)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url?: string;
}
