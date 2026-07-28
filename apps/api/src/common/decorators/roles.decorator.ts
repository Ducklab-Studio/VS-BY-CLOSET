import { SetMetadata } from '@nestjs/common';
import { Role } from '@loja/database';

export const ROLES_KEY = 'roles';

/** Restringe a rota a um ou mais papéis. Ex: @Roles(Role.ADMIN, Role.MANAGER) */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
