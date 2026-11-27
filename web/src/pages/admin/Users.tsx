// Account administration: users and what they can reach, invitations,
// and account-wide settings.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Copy, KeyRound, LogOut, Plus, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import type { Grant, User } from '../../types';
import { Badge, Button, Card, Checkbox, ErrorBox, FormModal, Modal, PageHeader, SelectField, Spinner, Table, Tabs, TextField, fmtTime, useLoad, useToast } from '../../ui';
import type { PlaceOption } from '../devices/DeviceForm';
import { GrantFields, describeGrant, grantBody, useProjects, type GrantDraft } from './Grants';

type Row = { user: User; grants: Grant[] };
type Invitation = { id: number; email: string | null; note: string | null; grants: GrantDraft[]; invited_by: number | null; created_at: string; expires_at: string };

/** Place names for describing grants, loaded per project as needed. */
function usePlaceNames(projectIds: number[]) {
  const [places, setPlaces] = useState<Record<number, PlaceOption[]>>({});
  const key = [...new Set(projectIds)].sort().join(',');
  useEffect(() => {
    for (const id of key.split(',').filter(Boolean).map(Number)) {
      api.get<PlaceOption[]>(`/api/projects/${id}/places`).then((p) => setPlaces((s) => ({ ...s, [id]: p })), () => {});
    }
  }, [key]);
  return places;
}

export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'users') as 'users' | 'invitations' | 'settings';
  return (
    <div>
      <PageHeader title="Users and access" />
      <Tabs
        tabs={[
          { id: 'users', label: 'Users' },
          { id: 'invitations', label: 'Invitations' },
          { id: 'settings', label: 'Account settings' },
        ]}
        value={tab}
        onChange={(t) => setParams(t === 'users' ? {} : { tab: t }, { replace: true })}
      />
      <div className="tab-panel">
        {tab === 'users' && <UserList />}
        {tab === 'invitations' && <Invitations />}
        {tab === 'settings' && <AccountSettings />}
      </div>
    </div>
  );
}

function UserList() {
  const users = useLoad(() => api.get<Row[]>('/api/users'), []);
  const projects = useProjects();
  const places = usePlaceNames((users.data ?? []).flatMap((r) => r.grants.filter((g) => g.scope_type !== 'account' && g.scope_type !== 'project').map((g) => g.project_id ?? 0)));
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  if (users.error) return <ErrorBox error={users.error} onRetry={users.reload} />;
  if (!users.data) return <Spinner />;
  const sel = users.data.find((r) => r.user.id === open);
  return (
    <div className="stack">
      <div className="row">
        <Button variant="primary" icon={<UserPlus size={15} />} onClick={() => setAdding(true)}>Add user</Button>
      </div>
      <Table
        rows={users.data}
        rowKey={(r) => r.user.id}
        onRowClick={(r) => setOpen(r.user.id)}
        columns={[
          { key: 'name', label: 'User', render: (r) => <><strong>{r.user.username}</strong>{r.user.display_name && <span className="muted"> · {r.user.display_name}</span>}</>, sort: (r) => r.user.username },
          { key: 'email', label: 'Email', render: (r) => r.user.email },
          {
            key: 'access',
            label: 'Access',
            render: (r) => (r.user.is_owner ? <Badge tone="accent">Owner</Badge> : r.grants.length ? <span className="small">{r.grants.map((g) => describeGrant(g, projects.data ?? [], places)).join('; ')}</span> : <span className="muted small">None</span>),
          },
          { key: '2fa', label: '2FA', render: (r) => (r.user.totp_enabled ? <Badge tone="ok">on</Badge> : <Badge>off</Badge>) },
          { key: 'last', label: 'Last sign-in', render: (r) => fmtTime(r.user.last_login_at), sort: (r) => r.user.last_login_at ?? '' },
          { key: 'state', label: '', render: (r) => (r.user.disabled ? <Badge tone="danger">disabled</Badge> : r.user.must_change_password ? <Badge tone="warn">must change password</Badge> : null) },
        ]}
      />
      {sel && <UserPanel row={sel} places={places} onClose={() => setOpen(null)} onChanged={users.reload} />}
      {adding && <AddUser onClose={() => setAdding(false)} onSaved={users.reload} />}
    </div>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="secret">
      <div className="small muted">{label}</div>
      <div className="row">
        <code className="mono">{value}</code>
        <Button variant="ghost" icon={<Copy size={14} />} onClick={() => navigator.clipboard?.writeText(value).then(() => toast.ok('Copied'), () => {})}>Copy</Button>
      </div>
    </div>
  );
}

function AddUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [email, setEmail] = useState('');
  const [made, setMade] = useState<{ user: User; temporary_password: string } | null>(null);
  if (made)
    return (
      <Modal title={`${made.user.username} added`} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p>Give them this temporary password. It's shown once; they choose their own at first sign-in. Then give them access from their user page.</p>
        <Secret label="Temporary password" value={made.temporary_password} />
      </Modal>
    );
  return (
    <FormModal
      title="Add user"
      submitLabel="Add"
      onClose={onClose}
      onSubmit={async () => {
        setMade(await api.post<{ user: User; temporary_password: string }>('/api/users', { username, display_name: display || undefined, email: email || undefined }));
        onSaved();
        return false;
      }}
    >
      <p className="small muted">Or send an invitation, so they pick their own username and password.</p>
      <TextField label="Username" required autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
      <TextField label="Display name" value={display} onChange={(e) => setDisplay(e.target.value)} />
      <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
    </FormModal>
  );
}

function UserPanel({ row, places, onClose, onChanged }: { row: Row; places: Record<number, PlaceOption[]>; onClose: () => void; onChanged: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const projects = useProjects();
  const u = row.user;
  const [display, setDisplay] = useState(u.display_name ?? '');
  const [email, setEmail] = useState(u.email ?? '');
  const [disabled, setDisabled] = useState(u.disabled);
  const [grant, setGrant] = useState<(GrantDraft & { project_id?: number | null }) | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const [armDelete, setArmDelete] = useState(false);
  const self = me?.user.id === u.id;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.ok(ok);
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={u.username} wide onClose={onClose}>
      <div className="stack">
        <Card title="Details">
          <div className="grid-2">
            <TextField label="Display name" value={display} onChange={(e) => setDisplay(e.target.value)} />
            <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {!u.is_owner && !self && <Checkbox label="Disabled (can't sign in)" checked={disabled} onChange={setDisabled} />}
          <Button onClick={() => act(() => api.patch(`/api/users/${u.id}`, { display_name: display, email, disabled: u.is_owner || self ? undefined : disabled }), 'Saved')}>Save details</Button>
        </Card>
        <Card title="Access">
          {u.is_owner ? (
            <p>The owner can do everything.</p>
          ) : (
            <div className="stack">
              {row.grants.length === 0 && <p className="muted">No access yet.</p>}
              <ul className="list">
                {row.grants.map((g) => (
                  <li key={g.id} className="row">
                    <span className="grow">{describeGrant(g, projects.data ?? [], places)}</span>
                    <Button variant="ghost" aria-label={`Remove ${describeGrant(g, projects.data ?? [], places)}`} icon={<Trash2 size={14} />} onClick={() => act(() => api.del(`/api/users/${u.id}/grants/${g.id}`), 'Access removed')} />
                  </li>
                ))}
              </ul>
              {grant ? (
                <div className="stack">
                  <GrantFields value={grant} onChange={setGrant} allowAccount />
                  <div className="row">
                    <Button
                      variant="primary"
                      onClick={() =>
                        act(async () => {
                          await api.post(`/api/users/${u.id}/grants`, grantBody(grant));
                          setGrant(null);
                        }, 'Access given')
                      }
                    >
                      Give access
                    </Button>
                    <Button variant="ghost" onClick={() => setGrant(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button icon={<Plus size={15} />} onClick={() => setGrant({ role: 'editor', scope_type: 'project', scope_id: null })}>Give access</Button>
              )}
            </div>
          )}
        </Card>
        <Card title="Security">
          {temp && <Secret label="Temporary password (shown once)" value={temp} />}
          <div className="row">
            <Button icon={<KeyRound size={15} />} onClick={() => act(async () => setTemp((await api.post<{ temporary_password: string }>(`/api/users/${u.id}/reset-password`)).temporary_password), 'Password reset')}>Reset password</Button>
            {u.totp_enabled && <Button icon={<ShieldOff size={15} />} onClick={() => act(() => api.post(`/api/users/${u.id}/reset-2fa`), 'Two-factor sign-in turned off')}>Turn off 2FA</Button>}
            {!self && <Button icon={<LogOut size={15} />} onClick={() => act(() => api.del(`/api/users/${u.id}/sessions`), 'Signed out everywhere')}>Sign out everywhere</Button>}
            {!u.is_owner && !self && (
              <Button
                variant="danger"
                icon={<Trash2 size={15} />}
                onClick={() => {
                  if (!armDelete) return setArmDelete(true);
                  act(() => api.del(`/api/users/${u.id}`), `Deleted ${u.username}`).then(onClose);
                }}
              >
                {armDelete ? 'Click again to delete the user' : 'Delete user'}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </Modal>
  );
}

function Invitations() {
  const list = useLoad(() => api.get<Invitation[]>('/api/invitations'), []);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const linkFor = (r: { url: string | null; token: string }) => r.url ?? `${window.location.origin}/invite/${r.token}`;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Spinner />;
  return (
    <div className="stack">
      <div className="row">
        <Button variant="primary" icon={<UserPlus size={15} />} onClick={() => setAdding(true)}>Invite someone</Button>
      </div>
      {link && <Card title="Invitation link (shown once)"><Secret label="Send this link; it works once" value={link} /></Card>}
      <Table
        rows={list.data}
        rowKey={(i) => i.id}
        empty="No pending invitations"
        columns={[
          { key: 'email', label: 'For', render: (i) => i.email ?? <span className="muted">anyone with the link</span> },
          { key: 'role', label: 'Access', render: (i) => i.grants.map((g) => `${g.role} (${g.scope_type})`).join(', ') },
          { key: 'note', label: 'Note', render: (i) => i.note },
          { key: 'expires', label: 'Expires', render: (i) => fmtTime(i.expires_at) },
          {
            key: 'actions',
            label: '',
            render: (i) => (
              <span className="row">
                <Button variant="ghost" onClick={async () => { try { setLink(linkFor(await api.post<{ url: string | null; token: string }>(`/api/invitations/${i.id}/reissue`))); } catch (e) { toast.error(e); } }}>New link</Button>
                <Button variant="ghost" onClick={async () => { await api.del(`/api/invitations/${i.id}`).catch(toast.error); list.reload(); }}>Revoke</Button>
              </span>
            ),
          },
        ]}
      />
      {adding && (
        <Invite
          onClose={() => setAdding(false)}
          onSaved={(r) => {
            setLink(linkFor(r));
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function Invite({ onClose, onSaved }: { onClose: () => void; onSaved: (r: { url: string | null; token: string }) => void }) {
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [grant, setGrant] = useState<GrantDraft & { project_id?: number | null }>({ role: 'editor', scope_type: 'project', scope_id: null });
  return (
    <FormModal
      title="Invite someone"
      submitLabel="Create invitation"
      wide
      onClose={onClose}
      onSubmit={async () => {
        onSaved(await api.post<{ url: string | null; token: string }>('/api/invitations', { email: email || undefined, note: note || undefined, grants: [grantBody(grant)] }));
      }}
    >
      <div className="grid-2">
        <TextField label="Their email" type="email" hint="Optional; for your own reference" value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <GrantFields value={grant} onChange={setGrant} allowAccount />
    </FormModal>
  );
}

function AccountSettings() {
  const { me } = useAuth();
  const toast = useToast();
  const settings = useLoad(() => api.get<{ require_2fa: boolean }>('/api/account/settings'), []);
  const users = useLoad(() => (me?.user.is_owner ? api.get<Row[]>('/api/users') : Promise.resolve([] as Row[])), [me?.user.is_owner]);
  const [to, setTo] = useState('');
  const [password, setPassword] = useState('');
  const [transferring, setTransferring] = useState(false);
  if (settings.error) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return <Spinner />;
  return (
    <div className="stack content-narrow">
      <Card title="Sign-in">
        <Checkbox
          label="Everyone must use two-factor sign-in"
          hint="People without it are asked to set it up at their next sign-in"
          checked={settings.data.require_2fa}
          onChange={async (c) => {
            settings.setData({ require_2fa: c });
            try {
              await api.patch('/api/account/settings', { require_2fa: c });
              toast.ok(c ? 'Two-factor sign-in is now required' : 'Two-factor sign-in is optional');
              settings.reload();
            } catch (e) {
              toast.error(e);
              settings.reload();
            }
          }}
        />
      </Card>
      {me?.user.is_owner && (
        <Card title="Ownership">
          <p className="small">The owner can do everything and can't be locked out. Hand it to another user; you become an account admin.</p>
          <Button variant="danger" onClick={() => setTransferring(true)}>Transfer ownership…</Button>
          {transferring && (
            <FormModal
              title="Transfer ownership"
              submitLabel="Transfer"
              danger
              onClose={() => setTransferring(false)}
              onSubmit={async () => {
                await api.post('/api/account/transfer-ownership', { user_id: Number(to), password });
                window.location.reload();
              }}
            >
              <SelectField label="New owner" value={to} onChange={(e) => setTo(e.target.value)} options={[{ value: '', label: 'Choose…' }, ...(users.data ?? []).filter((r) => !r.user.is_owner && !r.user.disabled).map((r) => ({ value: String(r.user.id), label: r.user.username }))]} />
              <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </FormModal>
          )}
        </Card>
      )}
    </div>
  );
}
