import { describe, expect, test } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateEmployeeDto } from './create-employee.dto';
import { UpdateEmployeePermissionsDto } from './update-employee-permissions.dto';

/**
 * Achado real: `AdminEmployeesController` valida o body com o
 * `ValidationPipe` global (`whitelist: true, forbidNonWhitelisted: true`
 * — ver main.ts), mas os testes de `AdminEmployeesService` chamam o
 * service direto, nunca passando por essa camada. `adminUserId` (lido
 * pelo `AdminRoleGuard` do body — ver admin-role.guard.ts) precisa estar
 * DECLARADO no DTO como campo opcional, senão o Nest recusa a requisição
 * inteira com "property adminUserId should not exist" — quebrou em
 * produção ao criar o primeiro funcionário pela tela.
 */
describe('CreateEmployeeDto / UpdateEmployeePermissionsDto — adminUserId aceito pelo ValidationPipe', () => {
  test('1) CreateEmployeeDto com adminUserId (UUID válido) não gera erro de whitelist', async () => {
    const dto = plainToInstance(CreateEmployeeDto, {
      adminUserId: '00000000-0000-0000-0000-000000000000',
      name: 'Funcionaria Teste',
      phone: '+56912345678',
      pin: '1234',
      role: 'STAFF',
      moduleAccess: ['RESERVATIONS'],
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  test('2) CreateEmployeeDto ainda recusa um campo realmente desconhecido (whitelist continua valendo pros outros)', async () => {
    const dto = plainToInstance(CreateEmployeeDto, {
      adminUserId: '00000000-0000-0000-0000-000000000000',
      name: 'Funcionaria Teste',
      phone: '+56912345678',
      pin: '1234',
      role: 'STAFF',
      moduleAccess: [],
      hacker: 'campo nunca declarado',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === 'hacker')).toBe(true);
  });

  test('3) UpdateEmployeePermissionsDto com adminUserId não gera erro de whitelist', async () => {
    const dto = plainToInstance(UpdateEmployeePermissionsDto, {
      adminUserId: '00000000-0000-0000-0000-000000000000',
      moduleAccess: ['AUDIT'],
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });
});
