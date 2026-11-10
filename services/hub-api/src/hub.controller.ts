import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocalUserDto } from './local-user.dto';
import { LocalUsersService } from './local-users.service';

@ApiTags('Hub entry')
@Controller()
export class HubController {
  constructor(@Inject(LocalUsersService) private readonly localUsers: LocalUsersService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get Hub API availability' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['available'] } },
      required: ['status'],
    },
  })
  getStatus(): { status: 'available' } {
    return { status: 'available' };
  }

  @Get('local-users')
  @ApiOperation({ summary: 'List locally configured Hub profiles' })
  @ApiOkResponse({ type: LocalUserDto, isArray: true })
  listLocalUsers(): LocalUserDto[] {
    return this.localUsers.list();
  }

  @Get('local-users/:id')
  @ApiOperation({ summary: 'Validate and return a locally configured Hub profile' })
  @ApiOkResponse({ type: LocalUserDto })
  @ApiNotFoundResponse({ description: 'The local profile does not exist.' })
  getLocalUser(@Param('id') id: string): LocalUserDto {
    const user = this.localUsers.findById(id);
    if (!user) {
      throw new NotFoundException('Local profile was not found.');
    }
    return user;
  }
}
