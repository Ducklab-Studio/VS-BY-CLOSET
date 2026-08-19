import type { Config } from 'tailwindcss';

/**
 * Paleta oficial da marca (recebida do cliente): marsala + creme como
 * cores principais, dourado/areia como apoio. `ink` (quase-preto) é o
 * quinto tom enviado, usado como texto — não é preto puro.
 *
 * Tipografia ainda não foi definida pelo cliente; `heading`/`body`
 * continuam apontando pras CSS variables que o layout injeta, então
 * trocar a fonte depois não exige mexer em componente nenhum.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#FFFCF6',
        marsala: '#53131E',
        ink: '#1F1D1C',
        sand: '#F2E5C6',
        gold: '#F2D9A0',
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
