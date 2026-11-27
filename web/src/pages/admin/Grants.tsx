// Choosing a role and where it applies: the account, a project, or one
// place or device inside a project.
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Grant, Project } from '../../types';
import { SelectField, useLoad } from '../../ui';
import type { PlaceOption } from '../devices/DeviceForm';

export interface GrantDraft {
  role: 'reader' | 'editor' | 'admin';
  scope_type: Grant['scope_type'];
  scope_id: number | null;
}

export const ROLE_TEXT = { reader: 'Reader', editor: 'Editor', admin: 'Admin' } as const;

export function useProjects() {
  return useLoad(() => api.get<Project[]>('/api/projects'), []);
}

/** "Editor of ACME / HQ / F1" */
export function describeGrant(g: Grant, projects: Project[], places: Record<number, PlaceOption[]>): string {
  const role = ROLE_TEXT[g.role];
  if (g.scope_type === 'account') return `${role} of everything`;
  const p = projects.find((x) => x.id === g.project_id);
  if (g.scope_type === 'project') return `${role} of ${p?.name ?? `project ${g.project_id}`}`;
  const place = places[g.project_id ?? 0]?.find((x) => x.kind === g.scope_type && x.id === g.scope_id);
  return `${role} of ${place ? place.path.split('/').join(' / ') : `${g.scope_type} ${g.scope_id}`}`;
}

export function GrantFields({ value, onChange, allowAccount }: { value: GrantDraft & { project_id?: number | null }; onChange: (g: GrantDraft & { project_id?: number | null }) => void; allowAccount: boolean }) {
  const projects = useProjects();
  const [places, setPlaces] = useState<PlaceOption[]>([]);
  const pid = value.project_id ?? projects.data?.[0]?.id ?? null;
  useEffect(() => {
    if (!pid) return;
    api.get<PlaceOption[]>(`/api/projects/${pid}/places`).then(setPlaces, () => setPlaces([]));
  }, [pid]);
  const where = value.scope_type === 'account' ? 'account' : value.scope_type === 'project' ? 'project' : 'place';
  const placeKey = value.scope_type !== 'account' && value.scope_type !== 'project' ? `${value.scope_type}:${value.scope_id}` : '';
  const set = (patch: Partial<GrantDraft & { project_id?: number | null }>) => onChange({ ...value, project_id: pid, ...patch });
  return (
    <div className="grid-3">
      <SelectField
        label="Role"
        value={value.role}
        onChange={(e) => {
          const role = e.target.value as GrantDraft['role'];
          // Reading is project-wide, so readers can't be limited to a place.
          set(role === 'reader' && where === 'place' ? { role, scope_type: 'project', scope_id: pid } : { role });
        }}
        options={[
          { value: 'reader', label: 'Reader (sees everything in it)' },
          { value: 'editor', label: 'Editor (changes things)' },
          { value: 'admin', label: 'Admin (also manages access and integrations)' },
        ]}
      />
      <SelectField
        label="Applies to"
        value={where}
        onChange={(e) =>
          set(
            e.target.value === 'account'
              ? { scope_type: 'account', scope_id: null }
              : e.target.value === 'project'
                ? { scope_type: 'project', scope_id: pid }
                : { scope_type: (places[0]?.kind ?? 'location') as Grant['scope_type'], scope_id: places[0]?.id ?? null },
          )
        }
        options={[
          ...(allowAccount ? [{ value: 'account', label: 'Every project' }] : []),
          { value: 'project', label: 'One project' },
          ...(value.role !== 'reader' ? [{ value: 'place', label: 'Part of a project' }] : []),
        ]}
      />
      {where !== 'account' && (
        <SelectField
          label="Project"
          value={String(pid ?? '')}
          onChange={(e) => {
            const id = Number(e.target.value);
            onChange({ ...value, project_id: id, ...(where === 'project' ? { scope_id: id } : { scope_type: 'location', scope_id: null }) });
          }}
          options={(projects.data ?? []).map((p) => ({ value: String(p.id), label: `${p.code} · ${p.name}` }))}
        />
      )}
      {where === 'place' && (
        <SelectField
          label="Where"
          value={placeKey}
          onChange={(e) => {
            const [kind, id] = e.target.value.split(':');
            set({ scope_type: kind as Grant['scope_type'], scope_id: Number(id) });
          }}
          options={[{ value: '', label: 'Choose…' }, ...places.map((p) => ({ value: `${p.kind}:${p.id}`, label: `${p.path.split('/').slice(1).join(' / ')} (${p.kind})` }))]}
        />
      )}
    </div>
  );
}

/** The body the API takes: project grants carry the project as scope_id. */
export function grantBody(g: GrantDraft & { project_id?: number | null }) {
  return { role: g.role, scope_type: g.scope_type, scope_id: g.scope_type === 'account' ? null : g.scope_type === 'project' ? (g.scope_id ?? g.project_id) : g.scope_id };
}
