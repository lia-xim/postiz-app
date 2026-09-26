'use client';

import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { CrawlFoundryNativeDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/cf-native.dto';

const SettingsComponent = () => {
  const form = useSettings();
  return (
    <div className="flex flex-col gap-3">
      <label>
        Content Center record ID
        <input className="w-full rounded border p-2" {...form.register('recordId')} />
      </label>
      <label>
        Record title
        <input className="w-full rounded border p-2" {...form.register('recordTitle')} />
      </label>
      <p>
        Create the first schedule in Crawl Foundry Content Center. Once the
        record is linked, change or cancel its release time here in Postiz.
        Content remains in Content Center.
      </p>
    </div>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent,
  CustomPreviewComponent: undefined,
  dto: CrawlFoundryNativeDto,
  maximumCharacters: 10000,
});
