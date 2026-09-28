'use client';

import { FC } from 'react';
import { PostComment, withProvider } from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { Input } from '@gitroom/react/form/input';
import { Blog2SocialMediumDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/blog2social-medium.dto';

const Settings: FC = () => {
  const form = useSettings();
  return <Input label="Article title" {...form.register('title')} />;
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: Settings,
  CustomPreviewComponent: undefined,
  dto: Blog2SocialMediumDto,
  maximumCharacters: 100000,
});
