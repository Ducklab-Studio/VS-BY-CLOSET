'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  Users,
  Package,
  AlertTriangle,
} from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { formatPrice } from '@/lib/utils';
import { formatDateTime, formatNumber, ORDER_STATUS } from '@/lib/admin-format';
import { Badge, Card, CardTitle, ErrorState, LoadingState, Table, Td, Th } from '@/components/admin/ui';
import { RevenueChart } from '@/components/admin/RevenueChart';
import type {
  DashboardStats,
  LowStockItem,
  RecentOrder,
  RevenuePoint,
  TopProduct,
} from '@/lib/admin-types';

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [series, setSeries] = useState<RevenuePoint[]>([]);
  const [top, setTop] = useState<TopProduct[]>([]);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);
  const [recent, setRecent] = useState<RecentOrder[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminApi.get<DashboardStats>('/admin/dashboard/stats'),
      adminApi.get<RevenuePoint[]>('/admin/dashboard/revenue-series', { days: 30 }),
      adminApi.get<TopProduct[]>('/admin/dashboard/top-products'),
      adminApi.get<LowStockItem[]>('/admin/dashboard/low-stock'),
      adminApi.get<RecentOrder[]>('/admin/dashboard/recent-orders'),
    ])
      .then(([s, sr, tp, ls, ro]) => {
        setStats(s);
        setSeries(sr);
        setTop(tp);
        setLowStock(ls);
        setRecent(ro);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!stats) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl text-white">Dashboard</h1>
        <p className="mt-1 text-sm text-white/50">Visão geral da loja nos últimos 30 dias.</p>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Receita (30d)"
          value={formatPrice(stats.revenue.last30d)}
          hint={`Total: ${formatPrice(stats.revenue.total)}`}
          change={stats.revenue.changePct}
        />
        <StatCard
          label="Pedidos (30d)"
          value={formatNumber(stats.orders.last30d)}
          hint={`${formatNumber(stats.orders.total)} no total`}
          icon={<ShoppingCart size={18} className="text-white/40" />}
        />
        <StatCard
          label="Clientes"
          value={formatNumber(stats.customers.total)}
          hint={`+${formatNumber(stats.customers.last30d)} novos em 30d`}
          icon={<Users size={18} className="text-white/40" />}
        />
        <StatCard
          label="Produtos ativos"
          value={formatNumber(stats.products.active)}
          hint={
            stats.pendingReviews > 0
              ? `${stats.pendingReviews} avaliação(ões) pendente(s)`
              : 'Nenhuma avaliação pendente'
          }
          icon={<Package size={18} className="text-white/40" />}
        />
      </div>

      {/* Gráfico de receita */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Receita diária (30 dias)</CardTitle>
        </div>
        <RevenueChart data={series} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Pedidos por status */}
        <Card>
          <CardTitle>Pedidos por status</CardTitle>
          <div className="mt-4 space-y-2">
            {stats.orders.byStatus.length === 0 ? (
              <p className="py-6 text-center text-sm text-white/40">Nenhum pedido ainda.</p>
            ) : (
              stats.orders.byStatus.map((s) => {
                const meta = ORDER_STATUS[s.status];
                const pct = stats.orders.total > 0 ? (s.count / stats.orders.total) * 100 : 0;
                return (
                  <div key={s.status} className="flex items-center gap-3">
                    <div className="w-36 shrink-0">
                      <Badge tone={meta?.tone}>{meta?.label ?? s.status}</Badge>
                    </div>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-white/70" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-10 text-right text-sm text-white/60">{s.count}</span>
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* Mais vendidos */}
        <Card>
          <CardTitle>Mais vendidos</CardTitle>
          <div className="mt-4 space-y-3">
            {top.length === 0 ? (
              <p className="py-6 text-center text-sm text-white/40">Nenhuma venda registrada.</p>
            ) : (
              top.map((p, i) => (
                <div key={p.sku} className="flex items-center gap-3">
                  <span className="font-heading w-6 text-lg text-white/30">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">{p.name}</p>
                    <p className="text-xs text-white/40">{p.sku}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-white">{formatPrice(p.revenue)}</p>
                    <p className="text-xs text-white/40">{p.quantity} un.</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Estoque baixo */}
      <Card>
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-300" />
          <CardTitle>Estoque baixo</CardTitle>
        </div>
        {lowStock.length === 0 ? (
          <p className="py-6 text-center text-sm text-white/40">
            Nenhum item com estoque abaixo do limite.
          </p>
        ) : (
          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>Produto</Th>
                  <Th>SKU</Th>
                  <Th>Variação</Th>
                  <Th className="text-right">Estoque</Th>
                </tr>
              </thead>
              <tbody>
                {lowStock.map((item) => (
                  <tr key={item.sku}>
                    <Td className="text-white">{item.productName}</Td>
                    <Td className="text-white/50">{item.sku}</Td>
                    <Td className="text-white/50">
                      {[item.color, item.size].filter(Boolean).join(' · ') || '—'}
                    </Td>
                    <Td className="text-right">
                      <Badge tone={item.quantity === 0 ? 'danger' : 'warning'}>
                        {item.quantity} / {item.lowStockAt}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* Pedidos recentes */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Pedidos recentes</CardTitle>
          <Link href="/admin/pedidos" className="text-xs uppercase tracking-widest text-white/50 hover:text-white">
            Ver todos
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-white/40">Nenhum pedido ainda.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Pedido</Th>
                <Th>Cliente</Th>
                <Th>Status</Th>
                <Th>Data</Th>
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <Link href={`/admin/pedidos/${o.id}`} className="text-white hover:underline">
                      #{o.number}
                    </Link>
                  </Td>
                  <Td>
                    <p className="text-white">{o.user.name}</p>
                    <p className="text-xs text-white/40">{o.user.email}</p>
                  </Td>
                  <Td>
                    <Badge tone={ORDER_STATUS[o.status]?.tone}>
                      {ORDER_STATUS[o.status]?.label ?? o.status}
                    </Badge>
                  </Td>
                  <Td className="text-white/50">{formatDateTime(o.createdAt)}</Td>
                  <Td className="text-right text-white">{formatPrice(o.total)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  change,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  change?: number | null;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <p className="text-[11px] font-medium uppercase tracking-widest text-white/50">{label}</p>
        {icon}
      </div>
      <p className="font-heading mt-3 text-2xl text-white">{value}</p>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {change != null && (
          <span
            className={
              change >= 0 ? 'flex items-center gap-1 text-emerald-300' : 'flex items-center gap-1 text-red-300'
            }
          >
            {change >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            {Math.abs(change).toFixed(1)}%
          </span>
        )}
        {hint && <span className="text-white/40">{hint}</span>}
      </div>
    </Card>
  );
}
