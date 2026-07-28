'use client';

import { useState } from 'react';
import { formatPrice } from '@/lib/utils';
import type { RevenuePoint } from '@/lib/admin-types';

const W = 720;
const H = 220;
const PAD = { top: 16, right: 8, bottom: 24, left: 8 };

/** Gráfico de área da receita diária — SVG puro, responsivo via viewBox. */
export function RevenueChart({ data }: { data: RevenuePoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return <p className="py-12 text-center text-sm text-white/40">Sem dados no período.</p>;
  }

  const max = Math.max(...data.map((d) => d.revenue), 1);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const points = data.map((d, i) => ({
    x: PAD.left + i * stepX,
    y: PAD.top + innerH - (d.revenue / max) * innerH,
    ...d,
  }));

  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const area = `${PAD.left},${PAD.top + innerH} ${line} ${PAD.left + innerW},${PAD.top + innerH}`;
  const active = hover != null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Receita por dia"
      >
        <defs>
          <linearGradient id="revenue-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line
            key={t}
            x1={PAD.left}
            x2={PAD.left + innerW}
            y1={PAD.top + innerH * t}
            y2={PAD.top + innerH * t}
            stroke="#ffffff"
            strokeOpacity="0.07"
          />
        ))}

        <polygon points={area} fill="url(#revenue-fill)" />
        <polyline points={line} fill="none" stroke="#ffffff" strokeWidth="2" />

        {active && (
          <>
            <line
              x1={active.x}
              x2={active.x}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke="#ffffff"
              strokeOpacity="0.3"
            />
            <circle cx={active.x} cy={active.y} r="4" fill="#ffffff" />
          </>
        )}

        {points.map((p, i) => (
          <rect
            key={p.date}
            x={p.x - stepX / 2}
            y={PAD.top}
            width={Math.max(stepX, 6)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      <div className="mt-1 flex justify-between text-[10px] uppercase tracking-widest text-white/35">
        <span>{new Date(data[0].date).toLocaleDateString('pt-BR')}</span>
        <span>{new Date(data[data.length - 1].date).toLocaleDateString('pt-BR')}</span>
      </div>

      {active && (
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-lg border border-white/15 bg-ink px-3 py-2 text-xs">
          <p className="text-white">{formatPrice(active.revenue)}</p>
          <p className="text-white/50">
            {new Date(active.date).toLocaleDateString('pt-BR')} · {active.orders} pedido(s)
          </p>
        </div>
      )}
    </div>
  );
}
