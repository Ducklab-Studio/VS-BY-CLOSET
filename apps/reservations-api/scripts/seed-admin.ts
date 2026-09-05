/**
 * Cria/atualiza um AdminUser a partir de variáveis de ambiente — nunca
 * hardcoded (achado real: a versão anterior deste script tinha nome,
 * telefone e PIN reais escritos direto no código, o que os deixaria no
 * histórico do git para sempre se commitado). O script só GERA o hash
 * antes de salvar; o PIN em texto puro nunca é gravado em lugar nenhum,
 * nem impresso no console.
 *
 * Uso:
 *   ADMIN_SEED_NAME="Nome" ADMIN_SEED_PHONE="+56 9 1234 5678" ADMIN_SEED_PIN="1234" \
 *     pnpm --filter @valle/reservations-api exec tsx scripts/seed-admin.ts
 *
 * `ADMIN_SEED_ROLE` é opcional (default "ADMIN"; aceita "ADMIN" ou "STAFF").
 */
import { PrismaClient, AdminRole } from '@prisma/client';
import { hashPin } from '../src/admin/admin-pin';
import { normalizePhone } from '../src/admin/admin-phone';

const prisma = new PrismaClient();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida. Veja o cabeçalho deste script para o uso correto.`);
  }
  return value;
}

async function main() {
  const name = requiredEnv('ADMIN_SEED_NAME');
  const rawPhone = requiredEnv('ADMIN_SEED_PHONE');
  const pin = requiredEnv('ADMIN_SEED_PIN');
  const roleRaw = (process.env.ADMIN_SEED_ROLE ?? 'ADMIN').toUpperCase();
  if (roleRaw !== 'ADMIN' && roleRaw !== 'STAFF') {
    throw new Error(`ADMIN_SEED_ROLE inválido: "${roleRaw}". Use "ADMIN" ou "STAFF".`);
  }
  const role = roleRaw as AdminRole;

  const normalizedPhone = normalizePhone(rawPhone);
  const pinHash = await hashPin(pin);

  console.log(`Configurando usuário: ${name} (${role})`);

  const user = await prisma.adminUser.upsert({
    where: { phone: normalizedPhone },
    update: { name, pinHash, role, active: true },
    create: { name, phone: normalizedPhone, pinHash, role, active: true },
  });

  // Nunca loga telefone/PIN — só o suficiente para confirmar que salvou.
  console.log('Admin user salvo com sucesso:', { id: user.id, name: user.name, role: user.role, active: user.active });
}

main()
  .catch((e) => {
    console.error('Erro ao configurar admin user:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
