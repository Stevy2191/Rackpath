import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Project } from '../types';
import { Button, Empty, ErrorBox, FormModal, PageHeader, Spinner, TextArea, TextField, useLoad } from '../ui';

export function ProjectsPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const projects = useLoad(() => api.get<Project[]>('/api/projects'), []);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ code: '', name: '', description: '' });
  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Each project is a separate set of sites, devices and addresses."
        actions={
          me?.is_account_admin && (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
              New project
            </Button>
          )
        }
      />
      <ErrorBox error={projects.error} onRetry={projects.reload} />
      {projects.loading && !projects.data && <Spinner />}
      {projects.data?.length === 0 && (
        <Empty title="No projects yet">{me?.is_account_admin ? 'Create the first one to start documenting.' : 'Ask an administrator for access to a project.'}</Empty>
      )}
      <div className="grid-3">
        {projects.data?.map((p) => (
          <button key={p.id} className="card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => nav(`/p/${p.id}`)}>
            <div className="card-body">
              <div className="u-label">{p.code}</div>
              <h2 style={{ marginTop: '0.3rem' }}>{p.name}</h2>
              {p.description && <p className="muted small">{p.description}</p>}
            </div>
          </button>
        ))}
      </div>
      {adding && (
        <FormModal
          title="New project"
          submitLabel="Create"
          onClose={() => setAdding(false)}
          onSubmit={async () => {
            const p = await api.post<Project>('/api/projects', { code: f.code, name: f.name, description: f.description || null });
            nav(`/p/${p.id}`);
            projects.reload();
          }}
        >
          <TextField label="Code" hint="Short and unique, e.g. ACME. It starts every path: ACME/HQ/2/MDF/RK01" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required />
          <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <TextArea label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </FormModal>
      )}
    </div>
  );
}
