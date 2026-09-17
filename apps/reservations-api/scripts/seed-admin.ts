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
 * `ADMIN_SEED_ROLE` é opcional (default "ADMIN"; aceita "SUPER_ADMIN",
 * "ADMIN" ou "STAFF").
 *
 * `ADMIN_SEED_MODULES` é opcional, lista separada por vírgula entre
 * RESERVATIONS, CALENDAR, PIECES, RULES, REPORTS, AUDIT — ignorado pra
 * SUPER_ADMIN (acesso total sempre, nunca lê esta lista). Sem módulos
 * concedidos, um ADMIN/STAFF novo não enxerga nada até o proprietário
 * conceder algo (painel Funcionários, ou rodando de novo com
 * ADMIN_SEED_MODULES setado).
 *
 * "Anderson deve ser o proprietário/superadmin" (singular, por
 * desenho): criar um SEGUNDO SUPER_ADMIN ativo exige confirmação
 * explícita via ADMIN_SEED_ALLOW_MULTIPLE_SUPER_ADMIN=true — proteção
 * contra rodar o script duas vezes por engano com ADMIN_SEED_ROLE
 * errado.
 */
import { PrismaClient, AdminRole, AdminModule } from '@prisma/client';
import { hashPin } from '../src/admin/admin-pin';
import { normalizePhone } from '../src/admin/admin-phone';

const prisma = new PrismaClient();
const VALID_ROLES: AdminRole[] = ['SUPER_ADMIN', 'ADMIN', 'STAFF'];
const VALID_MODULES: AdminModule[] = ['RESERVATIONS', 'CALENDAR', 'PIECES', 'RULES', 'REPORTS', 'AUDIT'];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida. Veja o cabeçalho deste script para o uso correto.`);
  }
  return value;
}

function parseModules(raw: string | undefined): AdminModule[] {
  if (!raw) return [];
  const modules = raw
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  for (const m of modules) {
    if (!VALID_MODULES.includes(m as AdminModule)) {
      throw new Error(`ADMIN_SEED_MODULES contém um módulo inválido: "${m}". Use: ${VALID_MODULES.join(', ')}.`);
    }
  }
  return [...new Set(modules)] as AdminModule[];
}

async function main() {
  const name = requiredEnv('ADMIN_SEED_NAME');
  const rawPhone = requiredEnv('ADMIN_SEED_PHONE');
  const pin = requiredEnv('ADMIN_SEED_PIN');
  const roleRaw = (process.env.ADMIN_SEED_ROLE ?? 'ADMIN').toUpperCase();
  if (!VALID_ROLES.includes(roleRaw as AdminRole)) {
    throw new Error(`ADMIN_SEED_ROLE inválido: "${roleRaw}". Use ${VALID_ROLES.join(', ')}.`);
  }
  const role = roleRaw as AdminRole;
  const moduleAccess = parseModules(process.env.ADMIN_SEED_MODULES);

  const normalizedPhone = normalizePhone(rawPhone);
  const pinHash = await hashPin(pin);

  if (role === 'SUPER_ADMIN' && process.env.ADMIN_SEED_ALLOW_MULTIPLE_SUPER_ADMIN !== 'true') {
    const existing = await prisma.adminUser.findMany({ where: { role: 'SUPER_ADMIN', active: true }, select: { phone: true } });
    const isNewAccount = !existing.some((u) => u.phone === normalizedPhone);
    if (isNewAccount && existing.length > 0) {
      throw new Error(
        `Já existe ${existing.length} SUPER_ADMIN ativo. "Anderson deve ser o proprietário" pressupõe um só — ` +
          `defina ADMIN_SEED_ALLOW_MULTIPLE_SUPER_ADMIN=true se isto for intencional.`,
      );
    }
  }

  console.log(`Configurando usuário: ${name} (${role}${role === 'SUPER_ADMIN' ? ', acesso total' : `, módulos: ${moduleAccess.join(', ') || '(nenhum)'}`})`);

  const user = await prisma.adminUser.upsert({
    where: { phone: normalizedPhone },
    update: { name, pinHash, role, active: true, moduleAccess },
    create: { name, phone: normalizedPhone, pinHash, role, active: true, moduleAccess },
  });

  // Nunca loga telefone/PIN — só o suficiente para confirmar que salvou.
  console.log('Admin user salvo com sucesso:', { id: user.id, name: user.name, role: user.role, active: user.active, moduleAccess: user.moduleAccess });
}

main()
  .catch((e) => {
    console.error('Erro ao configurar admin user:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
