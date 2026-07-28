import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { UsersService } from './users.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Perfil do usuário autenticado. */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.findById(user.sub);
  }

  @Patch('me')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.sub, dto);
  }
}
