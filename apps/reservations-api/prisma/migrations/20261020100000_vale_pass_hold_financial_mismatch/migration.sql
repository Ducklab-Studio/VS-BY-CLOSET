-- Valle Pass 2027 — PR E: novo motivo de retenção para pagamentos com valor, moeda, quantidade ou desconto fora do esperado.
--
-- Estritamente ADITIVA: só acrescenta UM valor ao tipo `vale_pass_hold_reason`. Nenhuma tabela, linha ou coluna é tocada, e nada passa a usar o
-- valor até a integração financeira (PR F, com autorização própria). Valor de enum não pode ser removido depois: se um dia for abandonado, fica sem uso.
--
-- `lock_timeout` evita esperar indefinidamente; `RESET` devolve a sessão ao padrão da conexão (o pré-deploy usa o pooler do Neon).
SET lock_timeout = '5s';

ALTER TYPE "vale_pass_hold_reason" ADD VALUE IF NOT EXISTS 'FINANCIAL_MISMATCH';

RESET lock_timeout;
