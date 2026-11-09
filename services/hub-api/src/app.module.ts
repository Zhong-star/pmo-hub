import { Module } from '@nestjs/common';
import { HubController } from './hub.controller';
import { LocalUsersService } from './local-users.service';

@Module({
  controllers: [HubController],
  providers: [LocalUsersService],
})
export class AppModule {}
