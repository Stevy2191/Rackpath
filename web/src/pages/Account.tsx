import { useState } from 'react';
import qrcode from 'qrcode-generator';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthCard } from './Login';
import { Badge, Button, Card, ErrorBox, FormModal, Modal, PageHeader, Table, TextField, fmtTime, message, useLoad, useToast } from '../ui';

// ---------------------------------------------------------------- password

function PasswordForm({ onDone, submitLabel = 'Change password' }: { onDone: () => void; submitLabel?: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (next !== again) {
          setError('The new passwords don’t match');
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await api.post('/api/auth/change-password', { current_password: current, new_password: next });
          onDone();
        } catch (err) {
          setError(message(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <TextField label="New password" type="password" autoComplete="new-password" hint="At least 10 characters" value={next} onChange={(e) => setNext(e.target.value)} required />
      <TextField label="New password again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" busy={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function ForcedPasswordChange() {
  const { refresh, logout } = useAuth();
  return (
    <AuthCard title="Choose a new password" intro="Your password was set by an administrator. Choose your own to continue.">
      <PasswordForm onDone={() => refresh()} submitLabel="Save and continue" />
      <Button variant="ghost" onClick={() => logout()} style={{ marginTop: '1rem' }}>
        Sign out
      </Button>
    </AuthCard>
  );
}

// ---------------------------------------------------------------- 2FA

function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(5, 2);
}

/** Enrolment: password → QR code → first code → recovery codes. */
export function TwoFactorSetup({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ otpauth_url: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (codes) {
    return (
      <div className="stack">
        <p>Two-factor sign-in is on. Keep these recovery codes somewhere safe: each signs you in once if you lose your phone.</p>
        <div className="codes">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <Button variant="primary" onClick={onDone}>
          I’ve saved them
        </Button>
      </div>
    );
  }
  if (setup) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await api.post<{ recovery_codes: string[] }>('/api/auth/totp/enable', { code: code.trim() });
            setCodes(r.recovery_codes);
          });
        }}
      >
        <p>Scan this with your authenticator app, then enter the code it shows.</p>
        <div className="qr">
          <img src={qrDataUrl(setup.otpauth_url)} alt="QR code for your authenticator app" />
        </div>
        <p className="small muted">
          Can’t scan? Enter this key: <code>{setup.secret}</code>
        </p>
        <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" busy={busy}>
          Turn on two-factor sign-in
        </Button>
      </form>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => setSetup(await api.post('/api/auth/totp/setup', { password })));
      }}
    >
      <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" busy={busy}>
        Continue
      </Button>
    </form>
  );
}

export function ForcedTwoFactor() {
  const { refresh, logout } = useAuth();
  return (
    <AuthCard title="Set up two-factor sign-in" intro="Your administrator requires two-factor sign-in for every account.">
      <TwoFactorSetup onDone={() => refresh()} />
      <Button variant="ghost" onClick={() => logout()} style={{ marginTop: '1rem' }}>
        Sign out
      </Button>
    </AuthCard>
  );
}

// ---------------------------------------------------------------- page

interface Session {
  id: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export function AccountPage() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const sessions = useLoad(() => api.get<Session[]>('/api/sessions'), []);
  const [modal, setModal] = useState<null | 'password' | 'enable' | 'disable' | 'codes'>(null);
  const [confirm, setConfirm] = useState({ password: '', code: '' });
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  if (!me) return null;
  const u = me.user;
  return (
    <div className="content-narrow">
      <PageHeader title="Your account" subtitle={u.username} />
      <div className="stack">
        <Card title="Password" actions={<Button onClick={() => setModal('password')}>Change</Button>}>
          <span className="muted">Changing it signs out your other sessions.</span>
        </Card>
        <Card
          title="Two-factor sign-in"
          actions={
            u.totp_enabled ? (
              <>
                <Button onClick={() => setModal('codes')}>New recovery codes</Button>
                <Button variant="danger" onClick={() => setModal('disable')} disabled={me.account_requires_2fa}>
                  Turn off
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => setModal('enable')}>
                Turn on
              </Button>
            )
          }
        >
          {u.totp_enabled ? (
            <span>
              <Badge tone="ok">On</Badge> {me.unused_recovery_codes} recovery code(s) left.
            </span>
          ) : (
            <span className="muted">Off. A code from your phone will be needed at each sign-in once it’s on.</span>
          )}
        </Card>
        <Card title="Signed-in sessions">
          <ErrorBox error={sessions.error} />
          <Table
            rows={sessions.data ?? []}
            rowKey={(s) => s.id}
            columns={[
              { key: 'where', label: 'Device', render: (s) => <span className="small">{s.user_agent ?? 'Unknown'}{s.current && <> <Badge tone="accent">this one</Badge></>}</span> },
              { key: 'ip', label: 'IP', render: (s) => <span className="mono small">{s.ip ?? '—'}</span> },
              { key: 'seen', label: 'Last active', render: (s) => fmtTime(s.last_seen_at) },
              {
                key: 'x',
                label: '',
                render: (s) =>
                  !s.current && (
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await api.del(`/api/sessions/${s.id}`);
                          sessions.reload();
                        } catch (e) {
                          toast.error(e);
                        }
                      }}
                    >
                      Sign out
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      </div>

      {modal === 'password' && (
        <Modal title="Change password" onClose={() => setModal(null)}>
          <PasswordForm
            onDone={() => {
              setModal(null);
              toast.ok('Password changed');
              refresh();
            }}
          />
        </Modal>
      )}
      {modal === 'enable' && (
        <Modal title="Two-factor sign-in" onClose={() => setModal(null)}>
          <TwoFactorSetup
            onDone={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {(modal === 'disable' || modal === 'codes') && !newCodes && (
        <FormModal
          title={modal === 'disable' ? 'Turn off two-factor sign-in' : 'New recovery codes'}
          danger={modal === 'disable'}
          submitLabel={modal === 'disable' ? 'Turn off' : 'Make new codes'}
          onClose={() => {
            setModal(null);
            setConfirm({ password: '', code: '' });
          }}
          onSubmit={async () => {
            const body = { password: confirm.password, code: confirm.code.trim() };
            if (modal === 'disable') {
              await api.post('/api/auth/totp/disable', body);
              toast.ok('Two-factor sign-in is off');
              refresh();
            } else {
              const r = await api.post<{ recovery_codes: string[] }>('/api/auth/totp/recovery-codes', body);
              setNewCodes(r.recovery_codes);
              refresh();
              return false;
            }
          }}
        >
          <TextField label="Password" type="password" value={confirm.password} onChange={(e) => setConfirm({ ...confirm, password: e.target.value })} required />
          <TextField label="Code from your app" inputMode="numeric" value={confirm.code} onChange={(e) => setConfirm({ ...confirm, code: e.target.value })} required />
        </FormModal>
      )}
      {newCodes && (
        <FormModal
          title="New recovery codes"
          submitLabel="I’ve saved them"
          onClose={() => {
            setNewCodes(null);
            setModal(null);
          }}
          onSubmit={async () => undefined}
        >
          <p>The old codes no longer work.</p>
          <div className="codes">
            {newCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </FormModal>
      )}
    </div>
  );
}
