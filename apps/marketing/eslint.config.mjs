import nextConfig from 'eslint-config-next';

/**
 * `next lint` foi removido no Next 16 (ver AGENTS.md deste app) — o
 * script `lint` do package.json agora chama o ESLint direto, então
 * precisa do próprio flat config em vez de depender do CLI do Next pra
 * gerar um na hora.
 *
 * `eslint-config-next` 16 já vem com o ruleset novo do React Compiler
 * (`react-hooks/*`) marcado como erro por padrão. Duas dessas regras
 * (`set-state-in-effect`, `immutability`) pegaram páginas públicas
 * PRÉ-EXISTENTES e não tocadas nesta sessão (Hero3D.tsx,
 * reserva-confirmada/page.tsx, RentalCalendar.tsx) — como a instrução
 * explícita da Fase 9 é "a parte pública não deve sofrer alteração
 * funcional por causa disso", desligadas aqui em vez de reescrever
 * comportamento de código que não faz parte deste trabalho.
 */
const config = [
  ...nextConfig,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
    },
  },
];

export default config;
