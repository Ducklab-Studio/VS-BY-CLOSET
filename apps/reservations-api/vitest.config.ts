import { defineConfig } from 'vitest/config';

/**
 * A suíte cresceu (18 arquivos, 200+ testes) e a maioria bate no Neon
 * real, cada arquivo abrindo seu próprio PrismaService/pool de conexão.
 * Em paralelo total (padrão do Vitest — vários processos worker ao
 * mesmo tempo), isso estourava o limite de conexões do pooler do Neon:
 * rodando a suíte inteira, testes que passam perfeitamente sozinhos
 * começaram a falhar com 503/timeout — não por bug de lógica, por
 * exaustão de conexão (confirmado reproduzindo: os mesmos testes
 * isolados passam sempre). `fileParallelism: false` roda os arquivos em
 * SEQUÊNCIA (dentro de cada arquivo, os testes/Promise.all continuam
 * concorrentes normalmente) — mais lento no relógio, mas é rodar
 * contra infraestrutura real, não testes unitários puros; confiabilidade
 * importa mais que velocidade aqui.
 *
 * `testTimeout: 20_000` — achado real (não hipotético): com o padrão do
 * Vitest (5s), vários testes de integração que só fazem 2-3 chamadas
 * sequenciais ao Neon real já estouravam o timeout por variação normal
 * de latência de rede, sem nenhum bug de lógica. Pior efeito colateral:
 * um teste estourando o timeout no MEIO de um describe pode interromper
 * o afterAll de limpeza do arquivo antes de ele rodar, deixando fixtures
 * órfãs no banco (ex.: peças "final-audit-..." aparecendo no ClosetAdmin
 * "Peças" depois de uma rodada de testes que teve timeouts). 20s dá
 * folga real sem mascarar timeout de verdade (os `$transaction` do
 * próprio código já usam até 20s — ver webhooks.service.ts).
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    globalSetup: ['./test/global-setup.ts'],
  },
});
