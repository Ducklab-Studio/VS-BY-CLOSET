-- Sistema de autorização de funcionários (parte 2/2).
-- Tudo aditivo/incremental — nenhuma coluna existente é alterada ou
-- removida, nenhuma linha é apagada.

-- Permissões por módulo: reservas, calendário, peças, regras,
-- relatórios e auditoria (item do pedido). SUPER_ADMIN ignora esta
-- lista por completo (acesso total, verificado em código).
CREATE TYPE admin_module AS ENUM (
  'RESERVATIONS',
  'CALENDAR',
  'PIECES',
  'RULES',
  'REPORTS',
  'AUDIT'
);

ALTER TABLE admin_users
  ADD COLUMN is_technical boolean NOT NULL DEFAULT false,
  ADD COLUMN module_access admin_module[] NOT NULL DEFAULT '{}',
  -- "Remover funcionário" nunca é DELETE (preserva a referência em
  -- auditoria/reservas manuais já registradas — a FK de
  -- admin_audit_events.admin_user_id continuaria valendo). Distinto de
  -- "bloquear" (active=false, reversível a qualquer momento): removido
  -- também fica com active=false, mas carrega quando e por quem foi
  -- removido.
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by uuid;

-- Backfill: preserva o acesso que cada conta já tinha na prática antes
-- desta migration (ninguém perde funcionalidade com o deploy).
-- ADMIN hoje já usa Reservas, Calendário, Peças, Regras/Bloqueios,
-- Relatórios e Auditoria inteiros.
UPDATE admin_users
SET module_access = ARRAY['RESERVATIONS','CALENDAR','PIECES','RULES','REPORTS','AUDIT']::admin_module[]
WHERE role = 'ADMIN';

-- STAFF hoje já usa Reservas, Calendário, Peças (visualização) e
-- Relatórios/PDF (nenhuma restrição de role nesses hoje) — nunca teve
-- Regras/Bloqueios nem Auditoria (@RequireRole('ADMIN') já bloqueava).
UPDATE admin_users
SET module_access = ARRAY['RESERVATIONS','CALENDAR','PIECES','REPORTS']::admin_module[]
WHERE role = 'STAFF';

-- Perfil técnico (Ciello) — identificado pelo id real da conta já
-- existente, nunca por nome/telefone em código. Continua com acesso
-- "normal" (mesmos módulos de ADMIN) — só passa a não ter login/logout
-- auditados e suas ações somem da auditoria visível a funcionários (ver
-- writeAdminAuditEvent / AdminAuditService).
UPDATE admin_users
SET is_technical = true
WHERE id = '71050b28-5c1a-4e7c-b53a-43d8b1ebe291'::uuid;

-- Auditoria: marca eventos críticos (alteração/cancelamento/permissões/
-- exclusão) e eventos de ator privilegiado (proprietário/técnico) — só
-- esses dois campos passam a controlar visibilidade pra funcionários;
-- nenhuma linha existente é escondida do Anderson/proprietário, e
-- nenhuma é apagada.
ALTER TABLE admin_audit_events
  ADD COLUMN is_critical boolean NOT NULL DEFAULT false,
  ADD COLUMN is_privileged boolean NOT NULL DEFAULT false;

UPDATE admin_audit_events
SET is_critical = true
WHERE action IN (
  'RULE_MODIFIED', 'UNIT_ACTIVATED', 'UNIT_DEACTIVATED', 'UNIT_UPDATED',
  'BLOCK_CREATED', 'BLOCK_REMOVED', 'SHOPIFY_UNITS_IMPORTED',
  'RESERVATIONS_ARCHIVED', 'RESERVATION_RESTORED',
  'RESERVATION_MANUAL_STATUS_CORRECTION', 'AUDIT_CLEARED'
);

UPDATE admin_audit_events
SET is_privileged = true
WHERE admin_user_id = '71050b28-5c1a-4e7c-b53a-43d8b1ebe291'::uuid;

CREATE INDEX admin_audit_events_is_privileged_idx ON admin_audit_events (is_privileged);
CREATE INDEX admin_audit_events_is_critical_idx ON admin_audit_events (is_critical);
