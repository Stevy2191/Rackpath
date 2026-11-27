// VLANs and WLANs of a project. WLANs never store a passphrase.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import type { Vlan, Wlan } from '../../types';
import { Badge, Button, Checkbox, ErrorBox, FormModal, PageHeader, SelectField, Spinner, Table, Tabs, TextArea, TextField, useLoad } from '../../ui';
import { useVlans } from '../ipam/Forms';
import { num, useForm } from '../places/common';

export const SECURITY = [
  { value: 'wpa2', label: 'WPA2 Personal' },
  { value: 'wpa3', label: 'WPA3 Personal' },
  { value: 'wpa2_wpa3', label: 'WPA2/WPA3 Personal' },
  { value: 'enterprise', label: 'Enterprise (802.1X)' },
  { value: 'owe', label: 'Enhanced Open (OWE)' },
  { value: 'open', label: 'Open' },
];

export function VlansPage() {
  const { project, canWrite } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'wlans' ? 'wlans' : 'vlans';
  const vlans = useVlans(project.id);
  const wlans = useLoad(() => api.get<{ wlans: Wlan[] }>(`/api/projects/${project.id}/wlans`).then((r) => r.wlans), [project.id]);
  const [modal, setModal] = useState<{ t: 'vlan'; v?: Vlan } | { t: 'wlan'; w?: Wlan } | null>(null);
  const close = () => setModal(null);
  return (
    <div>
      <PageHeader
        title="VLANs and Wi-Fi"
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal(tab === 'vlans' ? { t: 'vlan' } : { t: 'wlan' })}>
              {tab === 'vlans' ? 'Add VLAN' : 'Add WLAN'}
            </Button>
          )
        }
      />
      <Tabs
        tabs={[
          { id: 'vlans', label: 'VLANs' },
          { id: 'wlans', label: 'Wi-Fi networks' },
        ]}
        value={tab}
        onChange={(t) => setParams(t === 'vlans' ? {} : { tab: t }, { replace: true })}
      />
      <div className="tab-panel">
        {tab === 'vlans' &&
          (vlans.error ? (
            <ErrorBox error={vlans.error} onRetry={vlans.reload} />
          ) : !vlans.data ? (
            <Spinner />
          ) : (
            <Table
              rows={vlans.data}
              rowKey={(v) => v.id}
              onRowClick={canWrite ? (v) => setModal({ t: 'vlan', v }) : undefined}
              empty="No VLANs yet"
              columns={[
                { key: 'vid', label: 'ID', render: (v) => <span className="mono">{v.vid}</span>, sort: (v) => v.vid, className: 'num' },
                { key: 'name', label: 'Name', render: (v) => <span className="row"><span className="swatch" style={{ background: v.color ?? 'var(--color-border-strong)' }} />{v.name}</span>, sort: (v) => v.name },
                { key: 'desc', label: 'Description', render: (v) => v.description },
                { key: 'ports', label: 'Ports', render: (v) => v.port_count, sort: (v) => v.port_count, className: 'num' },
              ]}
            />
          ))}
        {tab === 'wlans' &&
          (wlans.error ? (
            <ErrorBox error={wlans.error} onRetry={wlans.reload} />
          ) : !wlans.data ? (
            <Spinner />
          ) : (
            <Table
              rows={wlans.data}
              rowKey={(w) => w.id}
              onRowClick={canWrite ? (w) => setModal({ t: 'wlan', w }) : undefined}
              empty="No Wi-Fi networks yet"
              columns={[
                {
                  key: 'ssid',
                  label: 'SSID',
                  render: (w) => (
                    <>
                      {w.ssid} {w.hidden && <Badge>hidden</Badge>}{' '}
                      {w.missing_from_source_at ? (
                        <Badge tone="warn">missing at source</Badge>
                      ) : (
                        w.source_integration_id != null && <Badge tone="info">imported</Badge>
                      )}
                    </>
                  ),
                  sort: (w) => w.ssid,
                },
                { key: 'sec', label: 'Security', render: (w) => SECURITY.find((s) => s.value === w.security)?.label },
                { key: 'vlan', label: 'VLAN', render: (w) => { const v = vlans.data?.find((x) => x.id === w.vlan_id); return v ? `${v.vid} ${v.name}` : null; } },
                { key: 'desc', label: 'Description', render: (w) => w.description },
                { key: 'ports', label: 'Radios', render: (w) => w.port_count, className: 'num' },
              ]}
            />
          ))}
      </div>
      {modal?.t === 'vlan' && <VlanForm projectId={project.id} existing={modal.v} onClose={close} onSaved={vlans.reload} />}
      {modal?.t === 'wlan' && <WlanForm projectId={project.id} existing={modal.w} vlans={vlans.data ?? []} onClose={close} onSaved={wlans.reload} />}
    </div>
  );
}

function VlanForm({ projectId, existing, onClose, onSaved }: { projectId: number; existing?: Vlan; onClose: () => void; onSaved: () => void }) {
  const f = useForm({ vid: existing ? String(existing.vid) : '', name: existing?.name ?? '', description: existing?.description ?? '', color: existing?.color ?? '', notes: existing?.notes ?? '' });
  const [arm, setArm] = useState(false);
  return (
    <FormModal
      title={existing ? `Edit VLAN ${existing.vid}` : 'Add VLAN'}
      onClose={onClose}
      onSubmit={async () => {
        const body = { ...f.values, vid: num(f.values.vid), color: f.values.color || null };
        if (existing) await api.patch(`/api/vlans/${existing.id}`, body);
        else await api.post(`/api/projects/${projectId}/vlans`, body);
        onSaved();
      }}
    >
      <div className="grid-2">
        <TextField label="VLAN ID" type="number" min={1} max={4094} required {...f.bind('vid')} />
        <TextField label="Name" required maxLength={80} {...f.bind('name')} />
        <TextField label="Colour" placeholder="#22c55e" {...f.bind('color')} />
        <TextField label="Description" {...f.bind('description')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
      {existing && (
        <Button
          variant="danger"
          onClick={async () => {
            if (!arm) return setArm(true);
            await api.del(`/api/vlans/${existing.id}`);
            onSaved();
            onClose();
          }}
        >
          {arm ? `Click again: removes it from ${existing.port_count} port(s)` : 'Delete VLAN'}
        </Button>
      )}
    </FormModal>
  );
}

function WlanForm({ projectId, existing, vlans, onClose, onSaved }: { projectId: number; existing?: Wlan; vlans: Vlan[]; onClose: () => void; onSaved: () => void }) {
  const f = useForm({ ssid: existing?.ssid ?? '', security: existing?.security ?? 'wpa2', vlan_id: existing?.vlan_id != null ? String(existing.vlan_id) : '', description: existing?.description ?? '', notes: existing?.notes ?? '' });
  const [hidden, setHidden] = useState(existing?.hidden ?? false);
  const [arm, setArm] = useState(false);
  return (
    <FormModal
      title={existing ? `Edit ${existing.ssid}` : 'Add Wi-Fi network'}
      onClose={onClose}
      onSubmit={async () => {
        const body = { ...f.values, hidden, vlan_id: num(f.values.vlan_id) };
        if (existing) await api.patch(`/api/wlans/${existing.id}`, body);
        else await api.post(`/api/projects/${projectId}/wlans`, body);
        onSaved();
      }}
    >
      <p className="small muted">Rackpath records the network, never its passphrase.</p>
      <div className="grid-2">
        <TextField label="SSID" required maxLength={32} {...f.bind('ssid')} />
        <SelectField label="Security" {...f.bind('security')} options={SECURITY} />
        <SelectField label="VLAN" {...f.bind('vlan_id')} options={[{ value: '', label: 'None' }, ...vlans.map((v) => ({ value: String(v.id), label: `${v.vid} ${v.name}` }))]} />
        <TextField label="Description" {...f.bind('description')} />
      </div>
      <Checkbox label="Hidden SSID" checked={hidden} onChange={setHidden} />
      <TextArea label="Notes" {...f.bind('notes')} />
      {existing && (
        <Button
          variant="danger"
          onClick={async () => {
            if (!arm) return setArm(true);
            await api.del(`/api/wlans/${existing.id}`);
            onSaved();
            onClose();
          }}
        >
          {arm ? 'Click again to delete' : 'Delete Wi-Fi network'}
        </Button>
      )}
    </FormModal>
  );
}

/** Untagged and tagged VLANs on a port. */
export function PortVlansForm({ projectId, portId, current, onClose, onSaved }: { projectId: number; portId: number; current: { id: number; mode: string }[]; onClose: () => void; onSaved: () => void }) {
  const vlans = useVlans(projectId);
  const [untagged, setUntagged] = useState(String(current.find((v) => v.mode === 'untagged')?.id ?? ''));
  const [tagged, setTagged] = useState<Set<number>>(new Set(current.filter((v) => v.mode === 'tagged').map((v) => v.id)));
  return (
    <FormModal
      title="Port VLANs"
      onClose={onClose}
      onSubmit={async () => {
        await api.put(`/api/ports/${portId}/vlans`, { untagged: num(untagged), tagged: [...tagged] });
        onSaved();
      }}
    >
      {!vlans.data ? (
        <Spinner />
      ) : vlans.data.length === 0 ? (
        <p className="muted">The project has no VLANs yet; add them under VLANs and Wi-Fi.</p>
      ) : (
        <>
          <SelectField label="Untagged (native)" value={untagged} onChange={(e) => setUntagged(e.target.value)} options={[{ value: '', label: 'None' }, ...vlans.data.map((v) => ({ value: String(v.id), label: `${v.vid} ${v.name}` }))]} />
          <fieldset className="checks">
            <legend>Tagged</legend>
            {vlans.data
              .filter((v) => String(v.id) !== untagged)
              .map((v) => (
                <Checkbox
                  key={v.id}
                  label={`${v.vid} ${v.name}`}
                  checked={tagged.has(v.id)}
                  onChange={(c) =>
                    setTagged((s) => {
                      const n = new Set(s);
                      if (c) n.add(v.id);
                      else n.delete(v.id);
                      return n;
                    })
                  }
                />
              ))}
          </fieldset>
        </>
      )}
    </FormModal>
  );
}
