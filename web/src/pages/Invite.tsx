import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthCard } from './Login';
import { Button, ErrorBox, Spinner, TextField, message, useLoad } from '../ui';

/** Accepting an invitation link: choose a username and password. */
export function InvitePage() {
  const { token = '' } = useParams();
  const { refresh } = useAuth();
  const nav = useNavigate();
  const preview = useLoad(
    () => api.get<{ email: string | null; invited_by: string | null; expires_at: string }>(`/api/invitations/accept/${encodeURIComponent(token)}`),
    [token],
  );
  const [f, setF] = useState({ username: '', display_name: '', password: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (preview.loading) return <AuthCard title="Invitation"><Spinner /></AuthCard>;
  if (preview.error) return <AuthCard title="Invitation" intro="This invitation link isn’t valid any more. Ask for a new one." />;
  return (
    <AuthCard title="Join Rackpath" intro={preview.data?.invited_by ? `${preview.data.invited_by} invited you.` : 'You’ve been invited.'}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (f.password !== f.again) {
            setError('The passwords don’t match');
            return;
          }
          setBusy(true);
          setError(null);
          try {
            await api.post(`/api/invitations/accept/${encodeURIComponent(token)}`, {
              username: f.username.trim(),
              password: f.password,
              display_name: f.display_name.trim() || null,
              email: preview.data?.email ?? null,
            });
            await refresh();
            nav('/');
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label="Username" autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required autoFocus />
        <TextField label="Your name" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        <TextField label="Password" type="password" autoComplete="new-password" hint="At least 10 characters" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        <TextField label="Password again" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} required />
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" busy={busy}>
          Create my account
        </Button>
      </form>
    </AuthCard>
  );
}
