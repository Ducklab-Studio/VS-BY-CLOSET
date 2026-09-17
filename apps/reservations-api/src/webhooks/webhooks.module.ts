import { Module } from '@nestjs/common';
import { ValePassModule } from '../vale-pass/vale-pass.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [ValePassModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
