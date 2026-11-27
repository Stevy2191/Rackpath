// A project's settings: its name, its device types and its tags.
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useProject } from '../layout/Shell';
import type { DeviceType } from '../types';
import { Badge, Button, Card, ErrorBox, FormModal, PageHeader, SelectField, Spinner, Table, Tabs, TextArea, TextField, useLoad, useToast } from '../ui';
import { useDeviceTypes } from './places/common';

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  device_count: number;
}

export function useTags(projectId: number) {
  return useLoad(() => api.get<{ tags: Tag[] }>(`/api/projects/${projectId}/tags`).then((r) => r.tags), [projectId]);
}

export function ProjectSettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'general') as 'general' | 'types' | 'tags';
  return (
    <div>
      <PageHeader title="Project settings" />
      <Tabs
        tabs={[
          { id: 'general', label: 'General' },
          { id: 'types', label: 'Device types' },
          { id: 'tags', label: 'Tags' },
        ]}
        value={tab}
        onChange={(t) => setParams(t === 'general' ? {} : { tab: t }, { replace: true })}
      />
      <div className="tab-panel">
        {tab === 'general' && <General />}
        {tab === 'types' && <DeviceTypes />}
        {tab === 'tags' && <Tags />}
      </div>
    </div>
  );
}

function General() {
  const { project, canManage, reloadProjects } = useProject();
  const toast = useToast();
  const nav = useNavigate();
  const [name, setName] = useState(project.name);
  const [code, setCode] = useState(project.code);
  const [description, setDescription] = useState(project.description ?? '');
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <div className="stack content-narrow">
      <Card title="Project">
        <fieldset disabled={!canManage} className="plain">
          <div className="grid-2">
            <TextField label="Code" maxLength={16} hint="Starts every path; changing it renames them all" value={code} onChange={(e) => setCode(e.target.value)} />
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api.patch(`/api/projects/${project.id}`, { code, name, description });
                toast.ok('Saved');
                reloadProjects();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Save
          </Button>
        </fieldset>
      </Card>
      {canManage && (
        <Card title="Delete project">
          <p className="small">Deletes every location, rack, device, cable, address and diagram in it. This can't be undone.</p>
          <Button variant="danger" onClick={() => setDeleting(true)}>Delete project…</Button>
        </Card>
      )}
      {deleting && (
        <FormModal
          title={`Delete ${project.name}`}
          submitLabel="Delete everything"
          danger
          onClose={() => setDeleting(false)}
          onSubmit={async () => {
            await api.del(`/api/projects/${project.id}`, { confirm_code: typed });
            await reloadProjects();
            nav('/projects');
          }}
        >
          <TextField label={`Type ${project.code} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </FormModal>
      )}
    </div>
  );
}

const PLACEMENTS = [
  { value: 'rack', label: 'In a rack' },
  { value: 'floor', label: 'In a room' },
  { value: 'either', label: 'Rack or room' },
  { value: 'tray', label: 'On a shelf' },
];

function DeviceTypes() {
  const { project, canManage } = useProject();
  const types = useDeviceTypes(project.id);
  const [edit, setEdit] = useState<DeviceType | 'new' | null>(null);
  if (types.error) return <ErrorBox error={types.error} onRetry={types.reload} />;
  if (!types.data) return <Spinner />;
  return (
    <div className="stack">
      {canManage && <Button icon={<Plus size={15} />} onClick={() => setEdit('new')}>Add device type</Button>}
      <Table
        rows={types.data}
        rowKey={(t) => t.id}
        onRowClick={canManage ? (t) => setEdit(t) : undefined}
        columns={[
          { key: 'label', label: 'Type', render: (t) => t.label, sort: (t) => t.label },
          { key: 'prefix', label: 'Code prefix', render: (t) => <span className="mono">{t.prefix}</span> },
          { key: 'placement', label: 'Goes', render: (t) => PLACEMENTS.find((p) => p.value === t.placement)?.label },
          { key: 'count', label: 'Devices', render: (t) => (t as DeviceType & { device_count?: number }).device_count ?? '', className: 'num' },
          { key: 'kind', label: '', render: (t) => (t.is_builtin ? <Badge>built-in</Badge> : <Badge tone="accent">custom</Badge>) },
        ]}
      />
      {edit && <TypeForm projectId={project.id} existing={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={types.reload} />}
    </div>
  );
}

function TypeForm({ projectId, existing, onClose, onSaved }: { projectId: number; existing?: DeviceType; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [key, setKey] = useState(existing?.key ?? '');
  const [prefix, setPrefix] = useState(existing?.prefix ?? '');
  const [placement, setPlacement] = useState<string>(existing?.placement ?? 'rack');
  const [arm, setArm] = useState(false);
  return (
    <FormModal
      title={existing ? `Edit ${existing.label}` : 'Add device type'}
      onClose={onClose}
      onSubmit={async () => {
        if (existing) await api.patch(`/api/device-types/${existing.id}`, { label, prefix, placement: existing.is_builtin ? undefined : placement });
        else await api.post(`/api/projects/${projectId}/device-types`, { key, label, prefix, placement });
        onSaved();
      }}
    >
      <div className="grid-2">
        <TextField label="Name" required value={label} onChange={(e) => setLabel(e.target.value)} />
        {!existing && <TextField label="Key" required placeholder="e.g. badge_reader" hint="Lowercase letters, digits and _" value={key} onChange={(e) => setKey(e.target.value)} />}
        <TextField label="Code prefix" required maxLength={6} hint="New devices get codes like SW01" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        <SelectField label="Goes" value={placement} disabled={existing?.is_builtin} onChange={(e) => setPlacement(e.target.value)} options={PLACEMENTS.filter((p) => p.value !== 'tray' || existing?.placement === 'tray')} />
      </div>
      {existing && !existing.is_builtin && (
        <Button
          variant="danger"
          onClick={async () => {
            if (!arm) return setArm(true);
            await api.del(`/api/device-types/${existing.id}`);
            onSaved();
            onClose();
          }}
        >
          {arm ? 'Click again to delete' : 'Delete type'}
        </Button>
      )}
    </FormModal>
  );
}

function Tags() {
  const { project, canWrite } = useProject();
  const tags = useTags(project.id);
  const [edit, setEdit] = useState<Tag | 'new' | null>(null);
  if (tags.error) return <ErrorBox error={tags.error} onRetry={tags.reload} />;
  if (!tags.data) return <Spinner />;
  return (
    <div className="stack">
      {canWrite && <Button icon={<Plus size={15} />} onClick={() => setEdit('new')}>Add tag</Button>}
      <Table
        rows={tags.data}
        rowKey={(t) => t.id}
        onRowClick={canWrite ? (t) => setEdit(t) : undefined}
        empty="No tags yet"
        columns={[
          { key: 'name', label: 'Tag', render: (t) => <TagChip tag={t} />, sort: (t) => t.name },
          { key: 'count', label: 'Devices', render: (t) => t.device_count, className: 'num', sort: (t) => t.device_count },
        ]}
      />
      {edit && <TagForm projectId={project.id} existing={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={tags.reload} />}
    </div>
  );
}

export function TagChip({ tag }: { tag: { name: string; color: string | null } }) {
  return (
    <span className="tag-chip">
      <span className="swatch" style={{ background: tag.color ?? 'var(--color-border-strong)' }} />
      {tag.name}
    </span>
  );
}

function TagForm({ projectId, existing, onClose, onSaved }: { projectId: number; existing?: Tag; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [color, setColor] = useState(existing?.color ?? '');
  const [arm, setArm] = useState(false);
  return (
    <FormModal
      title={existing ? `Edit tag ${existing.name}` : 'Add tag'}
      onClose={onClose}
      onSubmit={async () => {
        const body = { name, color: color || null };
        if (existing) await api.patch(`/api/tags/${existing.id}`, body);
        else await api.post(`/api/projects/${projectId}/tags`, body);
        onSaved();
      }}
    >
      <div className="grid-2">
        <TextField label="Name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Colour" placeholder="#f59e0b" value={color} onChange={(e) => setColor(e.target.value)} />
      </div>
      {existing && (
        <Button
          variant="danger"
          onClick={async () => {
            if (!arm) return setArm(true);
            await api.del(`/api/tags/${existing.id}`);
            onSaved();
            onClose();
          }}
        >
          {arm ? `Click again: untags ${existing.device_count} device(s)` : 'Delete tag'}
        </Button>
      )}
    </FormModal>
  );
}

/** Choosing a device's tags. */
export function DeviceTagsForm({ projectId, deviceId, current, onClose, onSaved }: { projectId: number; deviceId: number; current: number[]; onClose: () => void; onSaved: () => void }) {
  const tags = useTags(projectId);
  const [chosen, setChosen] = useState<Set<number>>(new Set(current));
  return (
    <FormModal
      title="Tags"
      onClose={onClose}
      onSubmit={async () => {
        await api.put(`/api/devices/${deviceId}/tags`, { tag_ids: [...chosen] });
        onSaved();
      }}
    >
      {!tags.data ? (
        <Spinner />
      ) : tags.data.length === 0 ? (
        <p className="muted">No tags yet; add them in the project settings.</p>
      ) : (
        <div className="checks">
          {tags.data.map((t) => (
            <label key={t.id} className="checkbox">
              <input
                type="checkbox"
                checked={chosen.has(t.id)}
                onChange={(e) =>
                  setChosen((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(t.id);
                    else n.delete(t.id);
                    return n;
                  })
                }
              />
              <TagChip tag={t} />
            </label>
          ))}
        </div>
      )}
    </FormModal>
  );
}
