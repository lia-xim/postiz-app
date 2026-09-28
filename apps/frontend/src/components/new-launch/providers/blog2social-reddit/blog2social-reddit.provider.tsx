'use client';

import { FC } from 'react';
import { PostComment, withProvider } from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { Input } from '@gitroom/react/form/input';
import { Blog2SocialRedditDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/blog2social-reddit.dto';

const Settings: FC = () => {
  const form = useSettings();
  return <>
    <Input label="Post title" {...form.register('title')} />
    <Input label="HTTPS link" {...form.register('url')} />
  </>;
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: Settings,
  CustomPreviewComponent: undefined,
  dto: Blog2SocialRedditDto,
  maximumCharacters: 10000,
});
