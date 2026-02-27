import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Bill, ProviderAccount } from '../lib/types';
import { AlertCircle, CheckCircle, Clock, CreditCard, TrendingUp } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
  partial: 'bg-orange-100 text-orange-800',
  cancelled: 'bg-gray-100 text-gray-500',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  overdue: 'Overdue',
  partial: 'Partial',
  cancelled: 'Cancelled',
};

function formatDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('el-GR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatAmount(n: number) {
  return new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(n);
}

function daysUntil(d: string) {
  const diff = Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Due today';
  return `${diff}d left`;
}

export default function Dashboard() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [billsRes, accountsRes] = await Promise.all([
        supabase.from('bills').select('*, providers(name, name_el, icon, color)').order('due_date', { ascending: true }),
        supabase.from('provider_accounts').select('*, providers(name, name_el, icon, color)').order('created_at'),
      ]);
      setBills(billsRes.data ?? []);
      setAccounts(accountsRes.data ?? []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-400">Loading...</div></div>;
  }

  const pendingBills = bills.filter(b => b.status === 'pending' || b.status === 'overdue');
  const totalDue = pendingBills.reduce((sum, b) => sum + Number(b.amount), 0);
  const overdueBills = bills.filter(b => b.status === 'overdue');
  const connectedAccounts = accounts.filter(a => a.status === 'connected');

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<CreditCard size={20} />} label="Total Due" value={formatAmount(totalDue)} color="blue" />
        <StatCard icon={<Clock size={20} />} label="Pending Bills" value={String(pendingBills.length)} color="yellow" />
        <StatCard icon={<AlertCircle size={20} />} label="Overdue" value={String(overdueBills.length)} color="red" />
        <StatCard icon={<TrendingUp size={20} />} label="Connected" value={`${connectedAccounts.length} / 5`} color="green" />
      </div>

      {/* Bills table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Bills</h2>
        </div>

        {bills.length === 0 ? (
          <div className="px-6 py-12 text-center text-gray-400">
            <p className="mb-2">No bills yet</p>
            <p className="text-sm">Connect a provider to start tracking bills automatically.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="px-6 py-3 font-medium">Provider</th>
                  <th className="px-6 py-3 font-medium">Title</th>
                  <th className="px-6 py-3 font-medium text-right">Amount</th>
                  <th className="px-6 py-3 font-medium">Due Date</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bills.map(bill => (
                  <tr key={bill.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-6 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span>{(bill.providers as any)?.icon || '📄'}</span>
                        <span className="font-medium">{(bill.providers as any)?.name || bill.provider_id}</span>
                      </span>
                    </td>
                    <td className="px-6 py-3 text-gray-700">{bill.title}</td>
                    <td className="px-6 py-3 text-right font-mono font-medium">{formatAmount(bill.amount)}</td>
                    <td className="px-6 py-3">
                      <div className="text-gray-700">{formatDate(bill.due_date)}</div>
                      {bill.status !== 'paid' && bill.due_date && (
                        <div className={`text-xs mt-0.5 ${new Date(bill.due_date) < new Date() ? 'text-red-500' : 'text-gray-400'}`}>
                          {daysUntil(bill.due_date)}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[bill.status] || 'bg-gray-100 text-gray-600'}`}>
                        {STATUS_LABELS[bill.status] || bill.status}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      {(bill.status === 'pending' || bill.status === 'overdue') && (
                        <button
                          onClick={async () => {
                            await supabase.from('bills').update({ status: 'paid', paid_at: new Date().toISOString(), paid_amount: bill.amount }).eq('id', bill.id);
                            setBills(prev => prev.map(b => b.id === bill.id ? { ...b, status: 'paid', paid_at: new Date().toISOString() } : b));
                          }}
                          className="text-xs text-green-600 hover:underline font-medium flex items-center gap-1"
                        >
                          <CheckCircle size={14} /> Mark paid
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    red: 'bg-red-50 text-red-600',
    green: 'bg-green-50 text-green-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${colors[color]}`}>{icon}</div>
        <div>
          <div className="text-2xl font-bold text-gray-900">{value}</div>
          <div className="text-sm text-gray-500">{label}</div>
        </div>
      </div>
    </div>
  );
}
