// Shapes of the v2 API's answers (see api-rs/README.md).

export interface User {
  id: number;
  username: string;
  email: string | null;
  display_name: string | null;
  is_owner: boolean;
  must_change_password: boolean;
  totp_enabled: boolean;
  disabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface Grant {
  id: number;
  role: 'reader' | 'editor' | 'admin';
  scope_type: 'account' | 'project' | 'location' | 'floor' | 'room' | 'rack' | 'device';
  scope_id: number | null;
  project_id: number | null;
  created_at: string;
}

export interface Me {
  user: User;
  mfa_pending: boolean;
  account_requires_2fa?: boolean;
  unused_recovery_codes?: number;
  is_account_admin?: boolean;
  grants?: Grant[];
}

export interface Project {
  id: number;
  code: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  can_edit?: boolean;
  can_manage?: boolean;
}

export interface SearchHit {
  kind: 'location' | 'floor' | 'room' | 'rack' | 'device' | 'port' | 'prefix' | 'address';
  id: number;
  project_id: number;
  path: string;
  detail?: string;
}
