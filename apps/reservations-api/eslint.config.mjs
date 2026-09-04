// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Bug real que já aconteceu neste projeto (o `webhookEvents` count
      // do relatório de auditoria quebrou ao serializar um BigInt do
      // Postgres) — deixar isso como aviso e não erro faria exatamente
      // esse tipo de coisa passar batido de novo.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
    },
  },
);
