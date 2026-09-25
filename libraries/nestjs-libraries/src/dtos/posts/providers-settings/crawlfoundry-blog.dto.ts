import { IsString, IsUUID } from 'class-validator';

export class CrawlFoundryBlogDto {
  @IsUUID()
  articleId: string;

  // A display snapshot for the calendar. Directus remains the content source.
  @IsString()
  articleTitle: string;
}
