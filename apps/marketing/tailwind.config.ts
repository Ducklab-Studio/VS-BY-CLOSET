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
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#FFFCF6',
        marsala: {
          DEFAULT: '#53131E',
          light: '#721C2B',
          glow: '#8E2235',
          dark: '#3A0D15',
        },
        ink: {
          DEFAULT: '#1F1D1C',
          light: '#2D2928',
          muted: '#8A827E',
        },
        sand: '#F2E5C6',
        gold: {
          DEFAULT: '#F2D9A0',
          light: '#F8E9C6',
          dark: '#D4B368',
        },
        dark: {
          bg: '#0C0A0B',
          surface: '#141012',
          card: '#1C1618',
          cardHover: '#251E21',
          popover: '#221B1E',
          text: '#FAF7F2',
          muted: '#9E948D',
          subtle: '#756C64',
        },
      },
      fontFamily: {
        heading: ['var(--font-heading)', 'serif'],
        body: ['var(--font-body)', 'sans-serif'],
      },
      boxShadow: {
        'glow-marsala': '0 0 25px rgba(83, 19, 30, 0.35)',
        'glow-gold': '0 0 20px rgba(242, 217, 160, 0.25)',
      },
    },
  },
  plugins: [],
};

export default config;
