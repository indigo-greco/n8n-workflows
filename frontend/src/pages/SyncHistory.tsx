import { useEffect, useState } from 'react';
import { supabase } from '../core/supabase';
import type { SyncJob } from '../core/types';
import { CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';

export default function SyncHistory() {
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('sync_jobs')
        .select('*, provider_accounts(provider_id, providers(name, name_el, icon))')
        .order('created_at', { ascending: false })
        .limit(50);
      setJobs(data ?? []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>;

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle size={16} className="text-green-500" />;
      case 'failed': return <XCircle size={16} className="text-red-500" />;
      case 'running': return <Loader2 size={16} className="text-blue-500 animate-spin" />;
      default: return <Clock size={16} className="text-gray-400" />;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Sync History</h2>
        <p className="text-sm text-gray-500 mt-1">Recent scraping jobs and their results.</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {jobs.length === 0 ? (
          <div className="px-6 py-12 text-center text-gray-400">No sync jobs yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Provider</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium">Bills</th>
                  <th className="px-6 py-3 font-medium">Duration</th>
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(job => {
                  const pa = job as any;
                  const providerName = pa.provider_accounts?.providers?.name || '—';
                  const providerIcon = pa.provider_accounts?.providers?.icon || '📄';

                  return (
                    <tr key={job.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-6 py-3">{statusIcon(job.status)}</td>
                      <td className="px-6 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <span>{providerIcon}</span>
                          <span>{providerName}</span>
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-500 capitalize">{job.job_type}</td>
                      <td className="px-6 py-3">
                        {job.status === 'completed' ? (
                          <span className="text-gray-700">
                            {job.bills_found} found, {job.bills_new} new
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-6 py-3 text-gray-500 font-mono">
                        {job.duration_ms ? `${(job.duration_ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                      <td className="px-6 py-3 text-gray-500 text-xs">
                        {new Date(job.created_at).toLocaleString('el-GR')}
                      </td>
                      <td className="px-6 py-3">
                        {job.error_code && (
                          <span className="text-xs text-red-600 font-mono">{job.error_code}</span>
                        )}
                        {job.error_message && (
                          <div className="text-xs text-red-500 max-w-48 truncate" title={job.error_message}>
                            {job.error_message}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
