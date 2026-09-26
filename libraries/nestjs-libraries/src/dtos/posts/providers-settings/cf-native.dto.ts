import { IsString, Matches, MaxLength } from 'class-validator';

/** The native record remains the content source; Postiz owns its release slot. */
export class CrawlFoundryNativeDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,200}$/)
  recordId: string;

  @IsString()
  @MaxLength(500)
  recordTitle: string;
}
