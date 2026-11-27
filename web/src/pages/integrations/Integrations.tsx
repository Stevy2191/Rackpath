// Integrations: UniFi, Zabbix and Windows DHCP/DNS read their records into
// the documentation. They never change anything at the source.
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Eye, Pencil, Plug, RefreshCw, RotateCw, Trash2, Upload } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, FormModal, Modal, PageHeader, SelectField, Spinner, TextField, Warnings, fmtTime, useLoad, useToast } from '../../ui';
import { useSpaces } from '../ipam/Forms';
import { KeyValues, num } from '../places/common';

export interface Integration {
  id: number;
  kind: 'windows_dhcp' | 'unifi' | 'unifi_protect' | 'unifi_access' | 'zabbix';
  name: string;
  base_url: string | null;
  username: string | null;
  auth_kind: string | null;
  has_secret: boolean;
  verify_tls: boolean;
  space_id: number | null;
  options: Record<string, unknown>;
  token_hint: string | null;
  auto_sync: boolean;
  sync_interval_minutes: number;
  hold_threshold_pct: number;
  last_sync_at: string | null;
  last_status: string | null;
  last_message: string | null;
  held_run_id?: number | null;
}

interface Summary {
  counts: Record<string, { created: number; updated: number; missing: number; restored: number; removed?: number }>;
  vlans_created: number;
  leases: number | null;
  owned_before: number;
  changed: number;
  newly_missing: number;
  warnings: string[];
  changes: string[];
  dry_run?: boolean;
  would_hold?: boolean;
  held?: boolean;
  skipped?: unknown;
}

interface Run {
  id: number;
  trigger: string;
  status: 'success' | 'failed' | 'held' | 'approved' | 'rejected' | string;
  started_at: string;
  finished_at: string | null;
  message: string | null;
  decided_at: string | null;
  summary: Summary | null;
}

export const KINDS: { value: Integration['kind']; label: string; hint: string }[] = [
  { value: 'windows_dhcp', label: 'Windows DHCP/DNS', hint: 'A PowerShell script on the DHCP server pushes scopes, reservations and DNS names; or upload an Export-DhcpServer XML file.' },
  { value: 'unifi', label: 'UniFi Network', hint: 'Gateways, switches and access points, networks and VLANs, and DHCP ranges and fixed IPs.' },
  { value: 'unifi_protect', label: 'UniFi Protect', hint: 'Cameras.' },
  { value: 'unifi_access', label: 'UniFi Access', hint: 'Access hubs and readers.' },
  { value: 'zabbix', label: 'Zabbix', hint: 'Hosts with their IPs and inventory, and a link back to Zabbix. No monitoring data.' },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;
const statusTone = (s: string | null) => (s === 'success' || s === 'approved' ? 'ok' : s === 'failed' || s === 'rejected' ? 'danger' : s === 'held' ? 'warn' : 'neutral');

export function IntegrationsPage() {
  const { project, canManage } = useProject();
  const nav = useNavigate();
  const list = useLoad(() => api.get<{ integrations: Integration[] }>(`/api/projects/${project.id}/integrations`).then((r) => r.integrations), [project.id]);
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState<{ id: number; token: string } | null>(null);
  return (
    <div>
      <PageHeader
        title="Integrations"
        subtitle="Sources that fill in the documentation; they only read, never change anything there"
        actions={
          <>
            {canManage && <Button variant="primary" icon={<Plug size={16} />} onClick={() => setAdding(true)}>Add integration</Button>}
            <Button icon={<Upload size={16} />} onClick={() => nav(`/p/${project.id}/import`)}>Import a CSV file</Button>
          </>
        }
      />
      <ErrorBox error={list.error} onRetry={list.reload} />
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty title="No integrations yet">Connect UniFi, Zabbix or your Windows DHCP servers, or import a CSV file.</Empty>
      ) : (
        <div className="grid-2">
          {list.data.map((i) => (
            <Link key={i.id} to={link.integration(project.id, i.id)} className="card integration-card" style={{ color: 'inherit' }}>
              <div className="card-body stack">
                <div className="row">
                  <strong>{i.name}</strong>
                  <Badge>{kindLabel(i.kind)}</Badge>
                  {i.held_run_id && <Badge tone="warn">waiting for approval</Badge>}
                </div>
                <div className="small muted">
                  {i.last_sync_at ? <>Last sync {fmtTime(i.last_sync_at)} · <Badge tone={statusTone(i.last_status)}>{i.last_status}</Badge></> : 'Never synced'}
                  {i.auto_sync && ` · every ${i.sync_interval_minutes} min`}
                </div>
                {i.last_message && <div className="small">{i.last_message}</div>}
              </div>
            </Link>
          ))}
        </div>
      )}
      {adding && (
        <IntegrationForm
          projectId={project.id}
          onClose={() => setAdding(false)}
          onSaved={(i) => {
            if (i.token) setToken({ id: i.id, token: i.token });
            else nav(link.integration(project.id, i.id));
            list.reload();
          }}
        />
      )}
      {token && <TokenShown projectId={project.id} {...token} onClose={() => nav(link.integration(project.id, token.id))} />}
    </div>
  );
}

function TokenShown({ token, onClose }: { projectId: number; id: number; token: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title="Import token" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>I've saved it</Button>}>
      <p>Put this token in the push script's settings on the DHCP server (see tools/windows in the Rackpath repository). It's shown once; you can rotate it later.</p>
      <div className="secret">
        <code className="mono">{token}</code>{' '}
        <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(token).then(() => toast.ok('Copied'), () => {})}>Copy</Button>
      </div>
      <p className="small muted">The script sends to {window.location.origin}/api/imports/windows-dhcp, at most once a minute.</p>
    </Modal>
  );
}

function IntegrationForm({ projectId, existing, onClose, onSaved }: { projectId: number; existing?: Integration; onClose: () => void; onSaved: (i: Integration & { token?: string }) => void }) {
  const spaces = useSpaces(projectId);
  const [kind, setKind] = useState<Integration['kind']>(existing?.kind ?? 'unifi');
  const [name, setName] = useState(existing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.base_url ?? '');
  const [authKind, setAuthKind] = useState(existing?.auth_kind ?? (kind === 'zabbix' ? 'token' : 'api_key'));
  const [username, setUsername] = useState(existing?.username ?? '');
  const [secret, setSecret] = useState('');
  const [verifyTls, setVerifyTls] = useState(existing?.verify_tls ?? true);
  const [space, setSpace] = useState(existing?.space_id != null ? String(existing.space_id) : '');
  const [site, setSite] = useState(String(existing?.options.site ?? ''));
  const [importDhcp, setImportDhcp] = useState(existing?.options.import_dhcp !== false);
  const [leases, setLeases] = useState(!!existing?.options.lease_snapshot);
  const [removeMissing, setRemoveMissing] = useState(!!existing?.options.remove_missing);
  const [autoSync, setAutoSync] = useState(existing?.auto_sync ?? true);
  const [interval, setInterval] = useState(String(existing?.sync_interval_minutes ?? 60));
  const [hold, setHold] = useState(String(existing?.hold_threshold_pct ?? 50));
  const remote = kind !== 'windows_dhcp';
  const unifi = kind.startsWith('unifi');
  const password = authKind === 'password';
  const authOptions = unifi
    ? [{ value: 'api_key', label: 'API key' }, { value: 'password', label: 'Local username and password' }]
    : [{ value: 'token', label: 'API token' }, { value: 'password', label: 'Username and password' }];
  return (
    <FormModal
      title={existing ? `Edit ${existing.name}` : 'Add integration'}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const options: Record<string, unknown> = {};
        if (unifi && site) options.site = site;
        if (kind === 'unifi') options.import_dhcp = importDhcp;
        if (kind === 'unifi' || kind === 'windows_dhcp') options.lease_snapshot = leases;
        options.remove_missing = removeMissing;
        const body: Record<string, unknown> = {
          name,
          space_id: num(space),
          options,
          hold_threshold_pct: num(hold) ?? 50,
          ...(remote && {
            base_url: baseUrl,
            auth_kind: authKind,
            username: password ? username : null,
            verify_tls: verifyTls,
            auto_sync: autoSync,
            sync_interval_minutes: num(interval) ?? 60,
          }),
          ...(remote && secret && { secret }),
        };
        if (!existing) body.kind = kind;
        onSaved(existing ? await api.patch<Integration>(`/api/integrations/${existing.id}`, body) : await api.post<Integration & { token?: string }>(`/api/projects/${projectId}/integrations`, body));
      }}
    >
      {!existing && (
        <SelectField
          label="Source"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as Integration['kind'];
            setKind(k);
            setAuthKind(k === 'zabbix' ? 'token' : 'api_key');
          }}
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
      )}
      <p className="small muted">{KINDS.find((k) => k.value === kind)?.hint}</p>
      <div className="grid-2">
        <TextField label="Name" required placeholder={kind === 'windows_dhcp' ? 'e.g. DHCP01' : 'e.g. Head office UniFi'} value={name} onChange={(e) => setName(e.target.value)} />
        {(spaces.data?.length ?? 0) > 1 && <SelectField label="Address space" value={space} onChange={(e) => setSpace(e.target.value)} options={[{ value: '', label: 'Default' }, ...(spaces.data ?? []).filter((s) => !s.is_default).map((s) => ({ value: String(s.id), label: s.name }))]} />}
        {remote && <TextField label="Address" required placeholder={kind === 'zabbix' ? 'https://zabbix.example.lan' : 'https://192.168.1.1'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}
        {remote && <SelectField label="Sign in with" value={authKind} onChange={(e) => setAuthKind(e.target.value)} options={authOptions} />}
        {remote && password && <TextField label="Username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />}
        {remote && (
          <TextField
            label={password ? 'Password' : authKind === 'token' ? 'API token' : 'API key'}
            type="password"
            autoComplete="new-password"
            placeholder={existing?.has_secret ? 'Saved; type to replace' : ''}
            hint="Stored encrypted and never shown again"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        )}
        {unifi && <TextField label="Site" placeholder="default" value={site} onChange={(e) => setSite(e.target.value)} />}
      </div>
      {remote && <Checkbox label="Check the server's certificate" hint="Untick only for a console with a self-signed certificate on a trusted network" checked={verifyTls} onChange={setVerifyTls} />}
      {kind === 'unifi' && <Checkbox label="Import DHCP ranges, DNS servers and fixed IPs" checked={importDhcp} onChange={setImportDhcp} />}
      <Checkbox
        label="Delete records that are gone from the source"
        hint="Off: they stay, marked “missing at source”. On: the next sync deletes them. A device with cables you documented, or devices on it, is kept and flagged. Big changes are still held for approval."
        checked={removeMissing}
        onChange={setRemoveMissing}
      />
      {(kind === 'unifi' || kind === 'windows_dhcp') && <Checkbox label="Keep the current DHCP leases as a separate layer" hint="Shown on the address map and counted in each prefix's Used figure; never turned into documentation" checked={leases} onChange={setLeases} />}
      {remote && (
        <div className="grid-2">
          <Checkbox label="Sync automatically" checked={autoSync} onChange={setAutoSync} />
          {autoSync && <TextField label="Every (minutes)" type="number" min={5} value={interval} onChange={(e) => setInterval(e.target.value)} />}
        </div>
      )}
      <TextField label="Hold for approval when more than this % would change" type="number" min={1} max={100} value={hold} onChange={(e) => setHold(e.target.value)} />
    </FormModal>
  );
}

const RECORD_LABEL: Record<string, string> = { wlan: 'Wi-Fi network' };

export function SyncSummary({ s }: { s: Summary }) {
  const rows = Object.entries(s.counts);
  return (
    <div className="stack">
      {(s.would_hold || s.held) && <Warnings items={[`${s.changed + s.newly_missing} of ${s.owned_before} records would change, more than the hold threshold; an admin must approve it.`]} />}
      {rows.length > 0 && (
        <table className="table small">
          <thead>
            <tr><th>Records</th><th className="num">New</th><th className="num">Updated</th><th className="num">Gone at the source</th><th className="num">Back again</th><th className="num">Deleted</th></tr>
          </thead>
          <tbody>
            {rows.map(([k, c]) => (
              <tr key={k}><td>{RECORD_LABEL[k] ?? k.replace(/_/g, ' ')}</td><td className="num">{c.created}</td><td className="num">{c.updated}</td><td className="num">{c.missing}</td><td className="num">{c.restored}</td><td className="num">{c.removed ?? 0}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {(s.vlans_created > 0 || s.leases != null) && (
        <p className="small">{[s.vlans_created ? `${s.vlans_created} VLAN(s) created` : null, s.leases != null ? `${s.leases} lease(s) in the lease layer` : null].filter(Boolean).join(' · ')}</p>
      )}
      <Warnings items={s.warnings} />
      {s.changes.length > 0 && (
        <details>
          <summary className="small">{s.changes.length} change(s)</summary>
          <ul className="small changes-list">{s.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function IntegrationPage() {
  const { project, canManage } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const integ = useLoad(() => api.get<Integration>(`/api/integrations/${id}`), [id]);
  const runs = useLoad(() => api.get<{ runs: Run[] }>(`/api/integrations/${id}/runs`).then((r) => r.runs), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; summary: Summary } | null>(null);
  const [modal, setModal] = useState<'edit' | 'delete' | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const reload = () => {
    integ.reload();
    runs.reload();
  };
  const go = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      reload();
    }
  };
  if (integ.error) return <ErrorBox error={integ.error} onRetry={integ.reload} />;
  if (!integ.data) return <Spinner />;
  const i = integ.data;
  const windows = i.kind === 'windows_dhcp';
  return (
    <div>
      <nav className="crumbs"><Link to={link.integrations(project.id)}>Integrations</Link></nav>
      <PageHeader
        title={i.name}
        subtitle={kindLabel(i.kind)}
        actions={
          canManage && (
            <>
              {!windows && (
                <Button
                  icon={<CheckCircle2 size={15} />}
                  busy={busy === 'test'}
                  onClick={() =>
                    go('test', async () => {
                      const r = await api.post<{ ok: boolean; message?: string; devices?: number; networks?: number; reservations?: number }>(`/api/integrations/${i.id}/test`);
                      if (r.ok) toast.ok(`Connected: ${r.devices} device(s), ${r.networks} network(s), ${r.reservations} reservation(s)`);
                      else toast.error(new Error(r.message ?? 'Connection failed'));
                    })
                  }
                >
                  Test connection
                </Button>
              )}
              {!windows && (
                <>
                  <Button icon={<Eye size={15} />} busy={busy === 'preview'} onClick={() => go('preview', async () => setResult({ title: 'What a sync would do', summary: await api.post<Summary>(`/api/integrations/${i.id}/sync?dry_run=true`) }))}>Preview</Button>
                  <Button variant="primary" icon={<RefreshCw size={15} />} busy={busy === 'sync'} onClick={() => go('sync', async () => setResult({ title: 'Sync finished', summary: await api.post<Summary>(`/api/integrations/${i.id}/sync`) }))}>Sync now</Button>
                </>
              )}
              {windows && (
                <>
                  <input ref={file} type="file" accept=".xml,text/xml" hidden onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) go('upload', async () => setResult({ title: `Imported ${f.name}`, summary: await api.upload<Summary>('POST', `/api/integrations/${i.id}/upload`, f, 'application/xml') }));
                  }} />
                  <Button variant="primary" icon={<Upload size={15} />} busy={busy === 'upload'} onClick={() => file.current?.click()}>Upload XML export</Button>
                  <Button icon={<RotateCw size={15} />} onClick={() => go('rotate', async () => setToken((await api.post<{ token: string }>(`/api/integrations/${i.id}/rotate-token`)).token))}>New token</Button>
                </>
              )}
              <Button icon={<Pencil size={15} />} onClick={() => setModal('edit')}>Edit</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal('delete')}>Delete</Button>
            </>
          )
        }
      />
      <div className="grid-2">
        <Card title="Settings">
          <KeyValues
            rows={[
              ['Address', i.base_url && <span className="mono">{i.base_url}</span>],
              ['Signs in with', i.auth_kind && `${i.auth_kind.replace('_', ' ')}${i.username ? ` as ${i.username}` : ''}${i.has_secret ? '' : ' (no secret saved)'}`],
              ['Certificate', !windows ? (i.verify_tls ? 'Checked' : <Badge tone="warn">not checked</Badge>) : null],
              ['Import token', windows ? (i.token_hint ? <span className="mono">{i.token_hint}</span> : 'none') : null],
              ['Site', i.options.site ? String(i.options.site) : null],
              ['DHCP', i.kind === 'unifi' ? (i.options.import_dhcp === false ? 'Not imported' : 'Ranges, DNS and fixed IPs imported') : null],
              ['Lease layer', i.options.lease_snapshot ? 'Kept' : null],
              ['Gone from the source', i.options.remove_missing ? 'Deleted at the next sync' : 'Kept, marked missing'],
              ['Automatic sync', !windows ? (i.auto_sync ? `Every ${i.sync_interval_minutes} minutes` : 'Off') : null],
              ['Held above', `${i.hold_threshold_pct}% changed`],
            ]}
          />
        </Card>
        <Card title="Last sync">
          {i.last_sync_at ? (
            <KeyValues rows={[['When', fmtTime(i.last_sync_at)], ['Result', <Badge tone={statusTone(i.last_status)}>{i.last_status}</Badge>], ['Message', i.last_message]]} />
          ) : (
            <p className="muted small">Never synced.</p>
          )}
        </Card>
      </div>
      <Card title="Runs" className="mt">
        {!runs.data ? (
          <Spinner />
        ) : runs.data.length === 0 ? (
          <p className="muted small">No runs yet.</p>
        ) : (
          <ul className="list runs">
            {runs.data.map((r) => (
              <li key={r.id} data-status={r.status}>
                <div className="row">
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  <span className="small mono">{fmtTime(r.started_at)}</span>
                  <span className="small muted">{r.trigger}</span>
                  {r.message && <span className="small">{r.message}</span>}
                  <span className="grow" />
                  {r.status === 'held' && canManage && (
                    <>
                      <Button variant="primary" busy={busy === `a${r.id}`} onClick={() => go(`a${r.id}`, async () => { await api.post(`/api/integrations/${i.id}/runs/${r.id}/approve`); toast.ok('Applied'); })}>Approve</Button>
                      <Button busy={busy === `r${r.id}`} onClick={() => go(`r${r.id}`, async () => { await api.post(`/api/integrations/${i.id}/runs/${r.id}/reject`); toast.ok('Rejected'); })}>Reject</Button>
                    </>
                  )}
                </div>
                {r.summary && (
                  <details open={r.status === 'held'}>
                    <summary className="small">Details</summary>
                    <SyncSummary s={r.summary} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {result && (
        <Modal title={result.title} wide onClose={() => setResult(null)} footer={<Button variant="primary" onClick={() => setResult(null)}>Close</Button>}>
          <SyncSummary s={result.summary} />
        </Modal>
      )}
      {token && <TokenShown projectId={project.id} id={i.id} token={token} onClose={() => setToken(null)} />}
      {modal === 'edit' && <IntegrationForm projectId={project.id} existing={i} onClose={() => setModal(null)} onSaved={reload} />}
      {modal === 'delete' && (
        <FormModal
          title={`Delete ${i.name}`}
          submitLabel="Delete"
          danger
          onClose={() => setModal(null)}
          onSubmit={async () => {
            await api.del(`/api/integrations/${i.id}`);
            nav(link.integrations(project.id));
          }}
        >
          <p>What it imported stays documented, as if entered by hand.</p>
        </FormModal>
      )}
    </div>
  );
}
