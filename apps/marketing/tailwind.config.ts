import type { Config } from 'tailwindcss';

/**
 * Cores e fontes ficam neutras até a identidade visual chegar — trocar aqui
 * quando o cliente enviar a marca definitiva, sem precisar reescrever
 * componente nenhum, já que tudo abaixo usa esses tokens.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#050505',
        surface: '#171717',
        muted: '#a3a3a3',
      },
      fontFamily: {
        heading: ['var(--font-heading)', 'serif'],
        body: ['var(--font-body)', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
