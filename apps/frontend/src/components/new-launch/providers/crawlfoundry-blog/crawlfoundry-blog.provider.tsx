'use client';

import { useEffect, useState } from 'react';
import { Select } from '@gitroom/react/form/select';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { useCustomProviderFunction } from '@gitroom/frontend/components/launches/helpers/use.custom.provider.function';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { CrawlFoundryBlogDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/crawlfoundry-blog.dto';

type ArticleChoice = { id: string; name: string };

const SettingsComponent = () => {
  const form = useSettings();
  const customFunc = useCustomProviderFunction();
  const [articles, setArticles] = useState<ArticleChoice[]>([]);
  const [loadError, setLoadError] = useState(false);
  const { name, onChange } = form.register('articleId');
  const [selected, setSelected] = useState<string>(
    form.getValues('articleId') || ''
  );

  useEffect(() => {
    customFunc
      .get('articles')
      .then((data: ArticleChoice[]) => setArticles(data))
      .catch(() => setLoadError(true));
  }, []);

  return (
    <>
      <input type="hidden" {...form.register('articleTitle')} />
      <Select
        name={name}
        label="Existing blog article"
        value={selected}
        onChange={(event) => {
          const article = articles.find(
            (item) => item.id === event.target.value
          );
          setSelected(event.target.value);
          form.setValue('articleTitle', article?.name || '', {
            shouldValidate: true,
          });
          onChange(event);
        }}
      >
        <option value="">Select a draft or scheduled article</option>
        {articles.map((article) => (
          <option key={article.id} value={article.id}>
            {article.name}
          </option>
        ))}
      </Select>
      {loadError && (
        <p role="alert">
          Could not load Directus articles. Check the blog channel connection.
        </p>
      )}
      <p>
        The text in this Postiz post is a note. The article content stays in
        Directus.
      </p>
    </>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent,
  CustomPreviewComponent: undefined,
  dto: CrawlFoundryBlogDto,
  maximumCharacters: 10000,
});
