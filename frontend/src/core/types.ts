export interface Provider {
  id: string;
  name: string;
  name_el: string;
  category: string;
  icon: string;
  color: string;
  login_url: string;
  portal_url: string;
  auth_method: string;
  requires_2fa: boolean;
  is_active: boolean;
  scraper_status: string;
}

export interface ProviderAccount {
  id: string;
  user_id: string;
  provider_id: string;
  username_masked: string;
  status: string;
  status_message: string | null;
  last_sync_at: string | null;
  last_sync_success: boolean | null;
  last_sync_bills_found: number;
  next_sync_at: string | null;
  sync_count: number;
  error_count: number;
  created_at: string;
  providers?: Provider;
}

export interface Bill {
  id: string;
  user_id: string;
  provider_account_id: string;
  provider_id: string;
  title: string;
  description: string | null;
  bill_type: string | null;
  amount: number;
  currency: string;
  due_date: string;
  issue_date: string | null;
  period_start: string | null;
  period_end: string | null;
  status: string;
  paid_at: string | null;
  paid_amount: number | null;
  reference_number: string | null;
  payment_code: string | null;
  source: string;
  notified_d3: boolean;
  notified_d0: boolean;
  created_at: string;
  updated_at: string;
  providers?: Provider;
}

export interface SyncJob {
  id: string;
  provider_account_id: string;
  user_id: string;
  status: string;
  job_type: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  bills_found: number;
  bills_new: number;
  bills_updated: number;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  notification_preferences: {
    email: boolean;
    push: boolean;
    sms: boolean;
  };
  timezone: string;
  language: string;
}
