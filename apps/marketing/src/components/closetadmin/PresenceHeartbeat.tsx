'use client';

import { useEffect } from 'react';
import { PRESENCE_HEARTBEAT_MS, PRESENCE_IDLE_MS } from '@/lib/closetadmin-presence';

const ENDPOINT = '/closetadmin/presence';

/**
 * Mantém o funcionário Online enquanto esta aba do painel está aberta e em uso.
 *  - heartbeat a cada 25 s (também em segundo plano: aba minimizada continua Online);
 *  - 10 min sem interação → avisa saída e para (volta sozinho na próxima interação);
 *  - fechar/recarregar a aba → avisa saída por `sendBeacon` (com fallback) — se
 *    isso falhar, o TTL de 90 s da API marca Offline do mesmo jeito;
 *  - sessão inválida (logout em outra aba, bloqueio, expiração) → para de vez.
 * Cada carregamento de página tem o próprio id aleatório: fechar uma aba nunca
 * derruba a presença de outra aba ou outro dispositivo. Não renderiza nada.
 */
export function PresenceHeartbeat() {
  useEffect(() => {
    const clientId = crypto.randomUUID();
    let stopped = false;
    let idle = false;
    let lastInteraction = Date.now();
    let lastMove = 0;

    const payload = (action: 'heartbeat' | 'leave') => JSON.stringify({ action, clientId });

    function leave() {
      const body = payload('leave');
      const sent = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      if (!sent) void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => undefined);
    }

    async function beat() {
      if (stopped) return;
      if (Date.now() - lastInteraction >= PRESENCE_IDLE_MS) {
        if (!idle) {
          idle = true;
          leave();
        }
        return;
      }
      try {
        const res = await fetch(ENDPOINT, { method: 'POST', body: payload('heartbeat'), cache: 'no-store' });
        if (res.status === 401) stopped = true;
      } catch {
        // Sem conexão: nada a fazer aqui — o TTL da API marca Offline.
      }
    }

    function activity() {
      lastInteraction = Date.now();
      if (idle) {
        idle = false;
        void beat();
      }
    }
    function onPointerMove() {
      const now = Date.now();
      if (now - lastMove > 5_000) {
        lastMove = now;
        activity();
      }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') activity();
    }
    function onPageShow(event: PageTransitionEvent) {
      // Voltou do cache de navegação (botão Voltar): a saída já foi avisada.
      if (event.persisted) {
        activity();
        void beat();
      }
    }
    const onOnline = () => void beat();

    const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    activityEvents.forEach((name) => window.addEventListener(name, activity, { passive: true }));
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);

    void beat();
    const timer = setInterval(() => void beat(), PRESENCE_HEARTBEAT_MS);

    return () => {
      clearInterval(timer);
      activityEvents.forEach((name) => window.removeEventListener(name, activity));
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      if (!stopped) leave();
      stopped = true;
    };
  }, []);

  return null;
}
