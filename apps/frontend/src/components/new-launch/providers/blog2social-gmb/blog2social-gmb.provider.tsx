'use client';

import { PostComment, withProvider } from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { Blog2SocialGmbDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/blog2social-gmb.dto';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { Input } from '@gitroom/react/form/input';

const Settings = () => {
  const form = useSettings();
  return <Input label="Link URL (optional)" placeholder="https://crawlfoundry.com/blog/..." {...form.register('url')} />;
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: Settings,
  CustomPreviewComponent: undefined,
  dto: Blog2SocialGmbDto,
  maximumCharacters: 1500,
});
