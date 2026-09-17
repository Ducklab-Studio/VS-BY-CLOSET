-- Valle Pass: novo módulo concedível a funcionários, separado dos 6
-- já existentes. Precisa ser sua própria migration: Postgres não
-- deixa usar um valor de enum recém-adicionado na MESMA transação
-- que o adicionou.
ALTER TYPE admin_module ADD VALUE 'VALLE_PASS';
