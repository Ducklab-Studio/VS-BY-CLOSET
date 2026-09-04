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
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
