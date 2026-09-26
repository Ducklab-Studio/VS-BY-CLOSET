'use client';

import { useEffect } from 'react';
import { startPresenceHeartbeat } from '@/lib/closetadmin-presence';

const ENDPOINT = '/closetadmin/presence';

/**
 * Mantém o funcionário Online enquanto esta aba do painel está aberta e
 * autenticada — heartbeat a cada 25 s, inclusive minimizada ou em segundo
 * plano, sem depender de mouse/teclado (a lógica fica em
 * `startPresenceHeartbeat`). Aqui só entram os eventos do navegador:
 *  - fechar/recarregar a aba → avisa a saída por `sendBeacon` (com fallback);
 *    se isso falhar, o TTL de 90 s da API marca Offline do mesmo jeito;
 *  - voltar do cache de navegação, reconectar ou a aba voltar a ficar visível →
 *    heartbeat na hora, sem esperar o próximo intervalo.
 * Cada carregamento de página tem o próprio id aleatório: fechar uma aba nunca
 * derruba a presença de outra aba ou outro dispositivo. Não renderiza nada.
 */
export function PresenceHeartbeat() {
  useEffect(() => {
    const heartbeat = startPresenceHeartbeat({
      clientId: crypto.randomUUID(),
      post: (body, keepalive) =>
        fetch(ENDPOINT, { method: 'POST', body, keepalive, cache: 'no-store' }).then(
          (res) => res.status,
          () => null,
        ),
      beacon: (body) =>
        typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' })),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    });

    const onPageHide = () => heartbeat.leave();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void heartbeat.beat();
    };
    const resync = () => void heartbeat.beat();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resync();
    };

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', resync);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', resync);
      document.removeEventListener('visibilitychange', onVisibility);
      heartbeat.stop();
    };
  }, []);

  return null;
}
