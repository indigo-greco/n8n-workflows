import { useEffect, useState } from 'react';
import { supabase } from '../core/supabase';
import type { Provider, ProviderAccount } from '../core/types';
import { useAuth } from '../core/auth';
import { Link2, Loader2, RefreshCw, Trash2, Wifi, WifiOff, X } from 'lucide-react';

const ACCOUNT_STATUS_DISPLAY: Record<string, { label: string; color: string }> = {
  connected: { label: 'Connected', color: 'text-green-600' },
  pending: { label: 'Pending...', color: 'text-yellow-600' },
  syncing: { label: 'Syncing...', color: 'text-blue-600' },
  error: { label: 'Error', color: 'text-red-600' },
  needs_otp: { label: '2FA Required', color: 'text-orange-600' },
  disconnected: { label: 'Disconnected', color: 'text-gray-400' },
};

export default function Providers() {
  const { session } = useAuth();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectModal, setConnectModal] = useState<Provider | null>(null);

  async function load() {
    const [pRes, aRes] = await Promise.all([
      supabase.from('providers').select('*').eq('is_active', true).order('name'),
      supabase.from('provider_accounts').select('*, providers(*)').order('created_at'),
    ]);
    setProviders(pRes.data ?? []);
    setAccounts(aRes.data ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const getAccount = (providerId: string) => accounts.find(a => a.provider_id === providerId);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-400">Loading...</div></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Providers</h2>
        <p className="text-sm text-gray-500 mt-1">Connect your accounts to automatically track bills.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map(provider => {
          const account = getAccount(provider.id);
          const status = account ? ACCOUNT_STATUS_DISPLAY[account.status] || { label: account.status, color: 'text-gray-500' } : null;

          return (
            <div key={provider.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-lg"
                    style={{ backgroundColor: provider.color + '15', color: provider.color }}
                  >
                    {provider.icon}
                  </div>
                  <div>
                    <div className="font-semibold text-gray-900">{provider.name}</div>
                    <div className="text-xs text-gray-400">{provider.name_el}</div>
                  </div>
                </div>
                {account ? (
                  <span className={`text-xs font-medium ${status!.color}`}>{status!.label}</span>
                ) : (
                  <span className="text-xs text-gray-400">Not connected</span>
                )}
              </div>

              <div className="text-xs text-gray-500 mb-4">
                Category: <span className="capitalize">{provider.category}</span>
                {provider.requires_2fa && <span className="ml-2 text-orange-500">(may require 2FA)</span>}
              </div>

              {account ? (
                <div className="space-y-2">
                  <div className="text-xs text-gray-400">
                    Account: <span className="font-mono">{account.username_masked}</span>
                  </div>
                  {account.last_sync_at && (
                    <div className="text-xs text-gray-400">
                      Last sync: {new Date(account.last_sync_at).toLocaleString('el-GR')}
                      {account.last_sync_success ? (
                        <span className="text-green-500 ml-1">({account.last_sync_bills_found} bills)</span>
                      ) : (
                        <span className="text-red-500 ml-1">(failed)</span>
                      )}
                    </div>
                  )}
                  {account.status_message && (
                    <div className="text-xs text-red-500">{account.status_message}</div>
                  )}
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={async () => {
                        await supabase.from('provider_accounts').update({ status: 'disconnected' }).eq('id', account.id);
                        load();
                      }}
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-600 transition-colors"
                    >
                      <Trash2 size={12} /> Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConnectModal(provider)}
                  className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
                >
                  <Link2 size={14} /> Connect
                </button>
              )}
            </div>
          );
        })}
      </div>

      {connectModal && (
        <ConnectModal
          provider={connectModal}
          token={session?.access_token ?? ''}
          onClose={() => setConnectModal(null)}
          onSuccess={() => { setConnectModal(null); load(); }}
        />
      )}
    </div>
  );
}

function ConnectModal({ provider, token, onClose, onSuccess }: {
  provider: Provider;
  token: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const placeholders: Record<string, { user: string; pass: string }> = {
    AADE: { user: 'Your AFM (tax number)', pass: 'TaxisNet password' },
    EFKA: { user: 'Your AFM (tax number)', pass: 'TaxisNet password' },
    DEH: { user: 'Email for mydei.dei.gr', pass: 'DEI password' },
    EYDAP: { user: 'Customer code / meter number', pass: 'EYDAP password' },
    COSMOTE: { user: 'Phone number or email', pass: 'COSMOTE password' },
  };
  const ph = placeholders[provider.id] || { user: 'Username', pass: 'Password' };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${supabaseUrl}/functions/v1/add-provider-account`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider_id: provider.id, username, password }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to connect. Please check your credentials.');
      } else {
        onSuccess();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{provider.icon}</span>
            <div>
              <h3 className="font-semibold text-gray-900">Connect {provider.name}</h3>
              <p className="text-xs text-gray-400">{provider.name_el}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        {provider.requires_2fa && (
          <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-lg text-orange-700 text-xs">
            This provider may require two-factor authentication (2FA). If the initial sync fails with "2FA Required", you'll need to complete verification on the provider's website first.
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              placeholder={ph.user}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder={ph.pass}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
            />
          </div>

          <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-3">
            Your credentials are encrypted with AES-256-GCM before storage. They are only used to log in to the provider's website to fetch your bills.
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
              {loading ? <><Loader2 size={14} className="animate-spin" /> Connecting...</> : 'Connect & Sync'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
