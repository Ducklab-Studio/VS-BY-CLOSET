import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminEmployeesController } from './admin-employees.controller';
import { AdminEmployeesService } from './admin-employees.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminEmployeesController],
  providers: [AdminEmployeesService, AdminRoleGuard],
  exports: [AdminEmployeesService],
})
export class AdminEmployeesModule {}
