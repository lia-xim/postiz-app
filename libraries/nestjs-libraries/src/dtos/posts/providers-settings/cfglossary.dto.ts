import { IsString, IsUUID } from 'class-validator';

export class CrawlFoundryGlossaryDto {
  @IsUUID()
  termId: string;

  // Calendar label only; the CMS remains the glossary content source.
  @IsString()
  termTitle: string;
}
