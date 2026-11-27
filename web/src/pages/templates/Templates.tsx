// Device templates: the built-in library and the project's own.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Plus } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Template, TemplateSummary } from '../../types';
import { Badge, Button, ErrorBox, FormModal, PageHeader, SelectField, Spinner, Table, TextField, useLoad, useToast } from '../../ui';
import { num, useDeviceTypes, useForm } from '../places/common';

export function TemplatesPage() {
  const { project, canWrite } = useProject();
  const nav = useNavigate();
  const toast = useToast();
  const list = useLoad(() => api.get<{ templates: TemplateSummary[] }>(`/api/projects/${project.id}/templates`).then((r) => r.templates), [project.id]);
  const [adding, setAdding] = useState(false);
  const duplicate = async (t: TemplateSummary) => {
    try {
      const copy = await api.post<Template>(`/api/templates/${t.id}/duplicate`, { project_id: project.id });
      toast.ok(`Copied ${t.name} into the project`);
      nav(link.template(project.id, copy.id));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <PageHeader
        title="Device templates"
        subtitle="Port layouts, heights and power figures that new devices start from"
        actions={canWrite && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>New template</Button>}
      />
      <ErrorBox error={list.error} onRetry={list.reload} />
      {!list.data ? (
        <Spinner />
      ) : (
        <Table
          rows={list.data}
          rowKey={(t) => t.id}
          onRowClick={(t) => nav(link.template(project.id, t.id))}
          columns={[
            { key: 'name', label: 'Name', render: (t) => <Link to={link.template(project.id, t.id)} onClick={(e) => e.stopPropagation()}>{t.name}</Link>, sort: (t) => t.name },
            { key: 'type', label: 'Type', render: (t) => t.device_type, sort: (t) => t.device_type },
            { key: 'model', label: 'Model', render: (t) => [t.manufacturer, t.model].filter(Boolean).join(' ') },
            { key: 'u', label: 'Height', render: (t) => (t.u_height == null ? '—' : t.u_height === 0 ? 'zero-U' : `${t.u_height}U`) },
            { key: 'devices', label: 'Devices', render: (t) => t.device_count, className: 'num', sort: (t) => t.device_count },
            {
              key: 'kind',
              label: '',
              render: (t) =>
                t.builtin ? (
                  <span className="row">
                    <Badge>built-in</Badge>
                    {canWrite && (
                      <Button variant="ghost" icon={<Copy size={14} />} onClick={(e) => { e.stopPropagation(); duplicate(t); }}>Copy to project</Button>
                    )}
                  </span>
                ) : (
                  <Badge tone="accent">v{t.version}</Badge>
                ),
            },
          ]}
        />
      )}
      {adding && <NewTemplate projectId={project.id} onClose={() => setAdding(false)} onSaved={(t) => nav(link.template(project.id, t.id))} />}
    </div>
  );
}

function NewTemplate({ projectId, onClose, onSaved }: { projectId: number; onClose: () => void; onSaved: (t: Template) => void }) {
  const types = useDeviceTypes(projectId);
  const f = useForm({ name: '', device_type: 'switch', u_height: '1', manufacturer: '', model: '' });
  return (
    <FormModal
      title="New template"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={async () => {
        const v = f.values;
        onSaved(
          await api.post<Template>(`/api/projects/${projectId}/templates`, {
            ...v,
            u_height: v.u_height === '' ? null : num(v.u_height),
            port_groups: [],
            port_overrides: [],
            elements: [],
          }),
        );
      }}
    >
      <TextField label="Name" required maxLength={80} placeholder="e.g. Core switch 48×1G + 4×SFP+" {...f.bind('name')} />
      <div className="grid-2">
        <SelectField label="Device type" {...f.bind('device_type')} options={(types.data ?? []).map((t) => ({ value: t.key, label: t.label }))} />
        <TextField label="Height (U)" type="number" min={0} step={0.5} hint="0 for zero-U (side-mounted); blank if not rack-mounted" {...f.bind('u_height')} />
        <TextField label="Manufacturer" {...f.bind('manufacturer')} />
        <TextField label="Model" {...f.bind('model')} />
      </div>
    </FormModal>
  );
}
