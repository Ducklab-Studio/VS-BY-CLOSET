-- Sistema de autorização de funcionários: novo papel SUPER_ADMIN
-- (proprietário — único, gerencia funcionários e permissões). Precisa
-- ser sua própria migration: Postgres não deixa usar um valor de enum
-- recém-adicionado na MESMA transação que o adicionou.
ALTER TYPE admin_role ADD VALUE 'SUPER_ADMIN';
