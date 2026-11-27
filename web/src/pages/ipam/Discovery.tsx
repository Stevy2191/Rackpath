// Network discovery: per-prefix ping sweeps (by hand or on a schedule),
// read-only SNMP devices, and the review list of what they found. Nothing
// found becomes documentation until someone documents it.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, EyeOff, Pencil, Play, Plus, Radar, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { DiscoveredHost, DiscoveryRun, PrefixDiscovery, SnmpSource } from '../../types';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, FormModal, SelectField, Spinner, Table, TextField, Warnings, fmtTime, message, useLoad, useToast } from '../../ui';

export const SCHEDULES = [
  { value: '', label: 'By hand only' },
  { value: '60', label: 'Every hour' },
  { value: '360', label: 'Every 6 hours' },
  { value: '1440', label: 'Every day' },
  { value: '10080', label: 'Every week' },
];

function scheduleLabel(minutes: number | null): string {
  return SCHEDULES.find((s) => s.value === String(minutes ?? ''))?.label ?? `Every ${minutes} minutes`;
}

function runSummary(r: DiscoveryRun): string {
  if (r.status === 'running') return 'Running…';
  if (r.status === 'failed') return `Failed: ${r.message ?? 'unknown error'}`;
  return `${r.found} answered, ${r.new_hosts} new`;
}

/** Waits for a run to finish, then calls `done` with it. */
async function follow(runId: number): Promise<DiscoveryRun> {
  for (;;) {
    const r = await api.get<DiscoveryRun>(`/api/discovery-runs/${runId}`);
    if (r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

// ---------------------------------------------------------------- prefix card

/** Scan settings, "Scan now" and what was found, on a prefix page. */
export function DiscoveryCard({ prefixId, onChanged }: { prefixId: number; onChanged: () => void }) {
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const d = useLoad(() => api.get<PrefixDiscovery>(`/api/prefixes/${prefixId}/discovery`), [prefixId, version]);
  const [editing, setEditing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const running = d.data?.runs.find((r) => r.status === 'running');
  // Pick up a run that was already going (a schedule, or another tab).
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => setVersion((v) => v + 1), 1500);
    return () => clearTimeout(t);
  }, [running]);
  if (d.error) return <Card title="Discovery" className="mt"><ErrorBox error={d.error} onRetry={d.reload} /></Card>;
  if (!d.data) return null;
  const x = d.data;
  const last = x.runs.find((r) => r.status !== 'running');
  const scan = async () => {
    setScanning(true);
    try {
      const { run_id } = await api.post<{ run_id: number }>(`/api/prefixes/${prefixId}/scan`);
      setVersion((v) => v + 1);
      const r = await follow(run_id);
      if (r.status === 'success') toast.ok(`Scan done: ${runSummary(r)}`);
      else toast.error(runSummary(r));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setScanning(false);
      setVersion((v) => v + 1);
      onChanged();
    }
  };
  return (
    <Card
      title={<span className="row"><Radar size={16} /> Discovery</span>}
      className="mt"
      actions={
        x.can_manage && (
          <>
            {x.scan_enabled && (
              <Button variant="primary" icon={<Play size={15} />} busy={scanning || !!running} onClick={scan}>
                Scan now
              </Button>
            )}
            {x.scannable && <Button variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Scan settings</Button>}
          </>
        )
      }
    >
      {!x.scannable ? (
        <p className="small muted">This prefix can't be scanned: {x.not_scannable_reason}</p>
      ) : !x.scan_enabled ? (
        <p className="small muted">
          Scanning is off. When an admin turns it on, Rackpath pings each address here once (gently, 32 at a time) and lists the hosts that answer for review. Nothing is
          added to the documentation by itself.
        </p>
      ) : (
        <p className="small">
          Scanning is on · {scheduleLabel(x.scan_interval_minutes)}
          {x.last_scan_at ? ` · last scan ${fmtTime(x.last_scan_at)}` : ' · not scanned yet'}
          {last ? ` · ${runSummary(last)}` : ''}
          {running ? ' · scanning now…' : ''}
        </p>
      )}
      <DiscoveredList prefixId={prefixId} version={version} onChanged={onChanged} compact />
      {editing && (
        <ScanSettingsForm
          prefixId={prefixId}
          current={x}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setVersion((v) => v + 1);
          }}
        />
      )}
    </Card>
  );
}

function ScanSettingsForm({ prefixId, current, onClose, onSaved }: { prefixId: number; current: PrefixDiscovery; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(current.scan_enabled);
  const [interval, setInterval] = useState(String(current.scan_interval_minutes ?? ''));
  return (
    <FormModal
      title="Scan settings"
      onClose={onClose}
      onSubmit={async () => {
        await api.patch(`/api/prefixes/${prefixId}/discovery`, {
          scan_enabled: enabled,
          scan_interval_minutes: interval ? Number(interval) : null,
        });
        onSaved();
      }}
    >
      <Checkbox
        label="Scan this prefix"
        checked={enabled}
        onChange={setEnabled}
        hint="Pings each address once with a 1 second timeout, 32 at a time, from the Rackpath server. Admins only; every scan is in the activity log."
      />
      <SelectField label="Schedule" value={interval} onChange={(e) => setInterval(e.target.value)} options={SCHEDULES} hint="You can always scan by hand with Scan now." />
    </FormModal>
  );
}

// ---------------------------------------------------------------- review list

/** Found hosts nobody has documented: document or ignore each. */
export function DiscoveredList({ prefixId, version = 0, onChanged, compact }: { prefixId?: number; version?: number; onChanged?: () => void; compact?: boolean }) {
  const { project } = useProject();
  const toast = useToast();
  const [state, setState] = useState<'new' | 'ignored'>('new');
  const [own, setOwn] = useState(0);
  const list = useLoad(
    () =>
      api
        .get<{ hosts: DiscoveredHost[]; can_edit: boolean }>(`/api/projects/${project.id}/discovered?state=${state}${prefixId ? `&prefix_id=${prefixId}` : ''}`),
    [project.id, prefixId, state, version, own],
  );
  const [documenting, setDocumenting] = useState<DiscoveredHost | null>(null);
  const changed = () => {
    setOwn((v) => v + 1);
    onChanged?.();
  };
  const setIgnored = async (h: DiscoveredHost, ignored: boolean) => {
    try {
      await api.post(`/api/discovered/${h.id}/ignore`, { ignored });
      toast.ok(ignored ? `Ignoring ${h.address}` : `${h.address} is back on the list`);
      changed();
    } catch (e) {
      toast.error(message(e));
    }
  };
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Spinner />;
  const { hosts, can_edit } = list.data;
  return (
    <div className="stack">
      <div className="row">
        <h3 className="u-label">{state === 'new' ? 'Found, not documented' : 'Ignored'}</h3>
        <span className="grow" />
        <Button variant="ghost" onClick={() => setState(state === 'new' ? 'ignored' : 'new')}>
          {state === 'new' ? 'Show ignored' : 'Show found'}
        </Button>
      </div>
      {hosts.length === 0 ? (
        compact ? (
          <p className="small muted">{state === 'new' ? 'Nothing waiting for review.' : 'Nothing ignored.'}</p>
        ) : (
          <Empty title={state === 'new' ? 'Nothing waiting for review' : 'Nothing ignored'}>
            {state === 'new' ? 'Hosts that answer a scan or show up in an SNMP device’s tables, at addresses nobody has documented, are listed here.' : null}
          </Empty>
        )
      ) : (
        <Table
          rows={hosts}
          rowKey={(h) => h.id}
          columns={[
            { key: 'address', label: 'Address', render: (h) => <span className="mono">{h.address}</span> },
            ...(prefixId
              ? []
              : [{ key: 'prefix', label: 'Prefix', render: (h: DiscoveredHost) => (h.prefix_id ? <Link to={link.prefix(project.id, h.prefix_id)} className="mono">{h.prefix}</Link> : <span className="muted">—</span>) }]),
            { key: 'dns', label: 'DNS name', render: (h) => h.dns_name },
            {
              key: 'mac',
              label: 'MAC',
              render: (h) => (
                <>
                  <span className="mono">{h.mac}</span>
                  {h.mac_documented_at && <div className="small muted">documented at {h.mac_documented_at}</div>}
                </>
              ),
            },
            { key: 'port', label: 'Switch port', render: (h) => h.switch_port },
            { key: 'by', label: 'Seen by', render: (h) => [h.seen_by_ping && 'ping', h.seen_by_snmp && 'SNMP'].filter(Boolean).join(', ') },
            { key: 'seen', label: 'Last seen', render: (h) => fmtTime(h.last_seen_at) },
            ...(can_edit
              ? [
                  {
                    key: 'act',
                    label: '',
                    render: (h: DiscoveredHost) =>
                      h.state === 'new' ? (
                        <span className="row">
                          <Button variant="ghost" icon={<Check size={14} />} aria-label={`Document ${h.address}`} onClick={() => setDocumenting(h)}>Document</Button>
                          <Button variant="ghost" icon={<EyeOff size={14} />} aria-label={`Ignore ${h.address}`} onClick={() => setIgnored(h, true)}>Ignore</Button>
                        </span>
                      ) : (
                        <Button variant="ghost" icon={<RotateCcw size={14} />} aria-label={`Restore ${h.address}`} onClick={() => setIgnored(h, false)}>Restore</Button>
                      ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {documenting && <DocumentForm host={documenting} onClose={() => setDocumenting(null)} onSaved={changed} />}
    </div>
  );
}

function DocumentForm({ host, onClose, onSaved }: { host: DiscoveredHost; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [dns, setDns] = useState(host.dns_name ?? '');
  return (
    <FormModal
      title={`Document ${host.address}`}
      submitLabel="Document"
      onClose={onClose}
      onSubmit={async () => {
        await api.post(`/api/discovered/${host.id}/document`, { description, dns_name: dns });
        toast.ok(`Documented ${host.address}`);
        onSaved();
      }}
    >
      <p className="small muted">
        Adds {host.address}
        {host.mac ? ` (MAC ${host.mac})` : ''} as a documented address. Link it to a device afterwards from the address page.
      </p>
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <TextField label="DNS name" value={dns} onChange={(e) => setDns(e.target.value)} hint="From reverse DNS, if the network had a name for it." />
    </FormModal>
  );
}

// ---------------------------------------------------------------- SNMP devices

const SECURITY_LABEL: Record<SnmpSource['security'], string> = {
  v3_auth_priv: 'SNMPv3, encrypted',
  v3_auth_no_priv: 'SNMPv3, not encrypted',
  v2c: 'SNMP v2c',
};

/** Routers and switches Rackpath reads ARP and MAC address tables from. */
export function SnmpSources() {
  const { project } = useProject();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const list = useLoad(() => api.get<{ sources: SnmpSource[]; can_manage: boolean }>(`/api/projects/${project.id}/snmp-sources`), [project.id, version]);
  const [modal, setModal] = useState<{ t: 'edit'; s?: SnmpSource } | { t: 'delete'; s: SnmpSource } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Spinner />;
  const reload = () => setVersion((v) => v + 1);
  const test = async (s: SnmpSource) => {
    setBusy(s.id);
    try {
      const r = await api.post<{ ok: boolean; message?: string; sys_name?: string; arp_entries?: number; mac_entries?: number }>(`/api/snmp-sources/${s.id}/test`);
      if (r.ok) toast.ok(`${r.sys_name ?? s.name} answered: ${r.arp_entries} ARP entries, ${r.mac_entries} MAC table entries (nothing saved)`);
      else toast.error(r.message ?? 'No answer');
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(null);
    }
  };
  const poll = async (s: SnmpSource) => {
    setBusy(s.id);
    try {
      const { run_id } = await api.post<{ run_id: number }>(`/api/snmp-sources/${s.id}/poll`);
      const r = await follow(run_id);
      if (r.status === 'success') toast.ok(`${s.name}: ${runSummary(r)}`);
      else toast.error(runSummary(r));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(null);
      reload();
    }
  };
  const { sources, can_manage } = list.data;
  return (
    <div className="stack">
      <p className="small muted">
        Rackpath reads routers’ ARP tables (which IP has which MAC) and switches’ MAC address tables (which port each MAC is on) with read-only SNMP. Use SNMPv3 with
        encryption where the device supports it. Credentials are stored encrypted and never shown again. Only private addresses can be polled.
      </p>
      {can_manage && (
        <div>
          <Button icon={<Plus size={15} />} onClick={() => setModal({ t: 'edit' })}>Add SNMP device</Button>
        </div>
      )}
      {sources.length === 0 ? (
        <Empty title="No SNMP devices" />
      ) : (
        <Table
          rows={sources}
          rowKey={(s) => s.id}
          columns={[
            { key: 'name', label: 'Name', render: (s) => <>{s.name} {!s.enabled && <Badge>off</Badge>}</> },
            { key: 'host', label: 'Address', render: (s) => <span className="mono">{s.host}{s.port !== 161 ? `:${s.port}` : ''}</span> },
            {
              key: 'sec',
              label: 'Security',
              render: (s) => <Badge tone={s.security === 'v3_auth_priv' ? 'ok' : 'warn'}>{SECURITY_LABEL[s.security]}</Badge>,
            },
            { key: 'reads', label: 'Reads', render: (s) => [s.read_arp && 'ARP', s.read_mac_table && 'MAC table'].filter(Boolean).join(', ') },
            { key: 'schedule', label: 'Schedule', render: (s) => scheduleLabel(s.poll_interval_minutes) },
            {
              key: 'last',
              label: 'Last poll',
              render: (s) =>
                s.last_poll_at ? (
                  <>
                    <Badge tone={s.last_status === 'success' ? 'ok' : 'danger'}>{s.last_status}</Badge> <span className="small">{fmtTime(s.last_poll_at)}</span>
                    {s.last_message && <div className="small muted">{s.last_message}</div>}
                  </>
                ) : (
                  <span className="muted">never</span>
                ),
            },
            ...(can_manage
              ? [
                  {
                    key: 'act',
                    label: '',
                    render: (s: SnmpSource) => (
                      <span className="row">
                        <Button variant="ghost" busy={busy === s.id} onClick={() => test(s)}>Test</Button>
                        <Button variant="ghost" icon={<Play size={14} />} disabled={!s.enabled || busy === s.id} onClick={() => poll(s)}>Poll now</Button>
                        <Button variant="ghost" aria-label={`Edit ${s.name}`} icon={<Pencil size={14} />} onClick={() => setModal({ t: 'edit', s })} />
                        <Button variant="ghost" aria-label={`Delete ${s.name}`} icon={<Trash2 size={14} />} onClick={() => setModal({ t: 'delete', s })} />
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {sources.some((s) => s.warnings.length > 0) && <Warnings items={sources.flatMap((s) => s.warnings.map((w) => `${s.name}: ${w}`))} />}
      {modal?.t === 'edit' && <SnmpForm projectId={project.id} existing={modal.s} onClose={() => setModal(null)} onSaved={reload} />}
      {modal?.t === 'delete' && (
        <FormModal
          title={`Delete ${modal.s.name}`}
          submitLabel="Delete"
          danger
          onClose={() => setModal(null)}
          onSubmit={async () => {
            await api.del(`/api/snmp-sources/${modal.s.id}`);
            reload();
          }}
        >
          <p>Rackpath stops polling it and forgets its credentials. What it found stays on the review list.</p>
        </FormModal>
      )}
    </div>
  );
}

function SnmpForm({ projectId, existing, onClose, onSaved }: { projectId: number; existing?: SnmpSource; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: existing?.name ?? '',
    host: existing?.host ?? '',
    port: String(existing?.port ?? 161),
    version: existing?.version ?? '3',
    community: '',
    v3_username: existing?.v3_username ?? '',
    v3_auth_protocol: existing?.v3_auth_protocol ?? 'sha256',
    v3_auth_password: '',
    v3_priv_protocol: existing ? existing.v3_priv_protocol ?? '' : 'aes128',
    v3_priv_password: '',
    read_arp: existing?.read_arp ?? true,
    read_mac_table: existing?.read_mac_table ?? true,
    enabled: existing?.enabled ?? true,
    poll_interval_minutes: String(existing?.poll_interval_minutes ?? ''),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const keep = existing && existing.version === f.version;
  const kept = 'Leave empty to keep the stored one';
  return (
    <FormModal
      title={existing ? `Edit ${existing.name}` : 'Add SNMP device'}
      onClose={onClose}
      wide
      onSubmit={async () => {
        const body: Record<string, unknown> = {
          name: f.name,
          host: f.host,
          port: Number(f.port) || 161,
          version: f.version,
          read_arp: f.read_arp,
          read_mac_table: f.read_mac_table,
          enabled: f.enabled,
          poll_interval_minutes: f.poll_interval_minutes ? Number(f.poll_interval_minutes) : null,
        };
        if (f.version === '2c') {
          if (f.community) body.community = f.community;
        } else {
          body.v3_username = f.v3_username;
          body.v3_auth_protocol = f.v3_auth_protocol;
          if (f.v3_auth_password) body.v3_auth_password = f.v3_auth_password;
          body.v3_priv_protocol = f.v3_priv_protocol || null;
          if (f.v3_priv_password) body.v3_priv_password = f.v3_priv_password;
        }
        if (existing) await api.patch(`/api/snmp-sources/${existing.id}`, body);
        else await api.post(`/api/projects/${projectId}/snmp-sources`, body);
        onSaved();
      }}
    >
      <div className="grid-2">
        <TextField label="Name" required value={f.name} onChange={set('name')} placeholder="core-switch" />
        <TextField label="IP address" required value={f.host} onChange={set('host')} placeholder="192.168.1.2" hint="A private address; not a host name." />
        <SelectField
          label="Version"
          value={f.version}
          onChange={set('version')}
          options={[
            { value: '3', label: 'SNMPv3 (recommended)' },
            { value: '2c', label: 'SNMP v2c (community string, unencrypted)' },
          ]}
        />
        <TextField label="Port" value={f.port} onChange={set('port')} inputMode="numeric" />
      </div>
      {f.version === '2c' ? (
        <>
          <Warnings items={['SNMP v2c sends the community string and the tables in clear text. Use a read-only community, and SNMPv3 if the device supports it.']} />
          <TextField label="Community" type="password" autoComplete="off" value={f.community} onChange={set('community')} hint={keep ? kept : 'A read-only community.'} />
        </>
      ) : (
        <div className="grid-2">
          <TextField label="User" value={f.v3_username} onChange={set('v3_username')} autoComplete="off" />
          <SelectField
            label="Authentication"
            value={f.v3_auth_protocol}
            onChange={set('v3_auth_protocol')}
            options={[
              { value: 'sha256', label: 'SHA-256' },
              { value: 'sha384', label: 'SHA-384' },
              { value: 'sha512', label: 'SHA-512' },
              { value: 'sha1', label: 'SHA-1 (weak)' },
            ]}
          />
          <TextField label="Authentication password" type="password" autoComplete="new-password" value={f.v3_auth_password} onChange={set('v3_auth_password')} hint={keep && existing?.has_auth_password ? kept : 'At least 8 characters.'} />
          <SelectField
            label="Privacy (encryption)"
            value={f.v3_priv_protocol}
            onChange={set('v3_priv_protocol')}
            options={[
              { value: 'aes128', label: 'AES-128' },
              { value: 'aes192', label: 'AES-192' },
              { value: 'aes256', label: 'AES-256' },
              { value: '', label: 'None (not encrypted)' },
            ]}
          />
          {f.v3_priv_protocol && (
            <TextField label="Privacy password" type="password" autoComplete="new-password" value={f.v3_priv_password} onChange={set('v3_priv_password')} hint={keep && existing?.has_priv_password ? kept : 'At least 8 characters.'} />
          )}
        </div>
      )}
      <Checkbox label="Read the ARP table" hint="Routers and layer 3 switches: which IP address has which MAC." checked={f.read_arp} onChange={(v) => setF({ ...f, read_arp: v })} />
      <Checkbox label="Read the MAC address table" hint="Switches: which port each MAC is on." checked={f.read_mac_table} onChange={(v) => setF({ ...f, read_mac_table: v })} />
      <SelectField label="Schedule" value={f.poll_interval_minutes} onChange={set('poll_interval_minutes')} options={SCHEDULES} />
      <Checkbox label="Enabled" checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
    </FormModal>
  );
}
