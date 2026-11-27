import { useState } from 'react';
import { useAuth } from '../auth';
import { Button, ErrorBox, TextField, message } from '../ui';

function Brand() {
  return (
    <div className="auth-brand">
      <img src="/favicon.svg" alt="" width={28} height={28} />
      Rackpath
    </div>
  );
}

export function AuthCard({ title, intro, children }: { title: string; intro?: string; children?: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1>{title}</h1>
        {intro && <p>{intro}</p>}
        {children}
      </div>
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthCard title="Sign in" intro="Infrastructure documentation for your sites, racks and cabling.">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(username, password);
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" busy={busy}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

export function SecondFactor() {
  const { submitMfa, logout } = useAuth();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthCard
      title="Two-factor sign-in"
      intro={recovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await submitMfa(code.trim(), recovery);
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label={recovery ? 'Recovery code' : 'Code'}
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          required
        />
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" busy={busy}>
          Continue
        </Button>
      </form>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: '1rem' }}>
        <Button variant="ghost" onClick={() => setRecovery(!recovery)}>
          {recovery ? 'Use an authenticator code' : 'Use a recovery code'}
        </Button>
        <Button variant="ghost" onClick={() => logout()}>
          Cancel
        </Button>
      </div>
    </AuthCard>
  );
}
