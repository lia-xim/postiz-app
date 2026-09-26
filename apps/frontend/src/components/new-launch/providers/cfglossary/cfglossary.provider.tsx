'use client';

import { useEffect, useState } from 'react';
import { Select } from '@gitroom/react/form/select';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { useCustomProviderFunction } from '@gitroom/frontend/components/launches/helpers/use.custom.provider.function';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { CrawlFoundryGlossaryDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/cfglossary.dto';

type TermChoice = { id: string; name: string };

const SettingsComponent = () => {
  const form = useSettings();
  const customFunc = useCustomProviderFunction();
  const [terms, setTerms] = useState<TermChoice[]>([]);
  const [loadError, setLoadError] = useState(false);
  const { name, onChange } = form.register('termId');
  const [selected, setSelected] = useState<string>(
    form.getValues('termId') || ''
  );

  useEffect(() => {
    customFunc
      .get('terms')
      .then((data: TermChoice[]) => setTerms(data))
      .catch(() => setLoadError(true));
  }, []);

  return (
    <>
      <input type="hidden" {...form.register('termTitle')} />
      <Select
        name={name}
        label="Existing glossary term"
        value={selected}
        onChange={(event) => {
          const term = terms.find((item) => item.id === event.target.value);
          setSelected(event.target.value);
          form.setValue('termTitle', term?.name || '', {
            shouldValidate: true,
          });
          onChange(event);
        }}
      >
        <option value="">Select a published term awaiting release</option>
        {terms.map((term) => (
          <option key={term.id} value={term.id}>
            {term.name}
          </option>
        ))}
      </Select>
      {loadError && (
        <p role="alert">
          Could not load Directus terms. Check the glossary channel connection.
        </p>
      )}
      <p>
        The text in this Postiz post is a note. The glossary content stays in
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
  dto: CrawlFoundryGlossaryDto,
  maximumCharacters: 10000,
});
