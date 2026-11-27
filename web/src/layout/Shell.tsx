import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LayoutDashboard, LayoutTemplate, Settings, LogOut, MapPin, Network, Server, Waypoints, Moon, Sun, UserCircle2, FolderKanban, Users, History } from 'lucide-react';
import { api } from '../api';
import { projectRights, useAuth } from '../auth';
import { applyTheme, currentTheme } from '../theme';
import type { Project } from '../types';
import { useLoad, Spinner, ErrorBox } from '../ui';
import { Search } from './Search';

export interface ProjectCtx {
  project: Project;
  projects: Project[];
  reloadProjects: () => void;
  /** Project-wide rights from the user's grants (deeper grants show up per item). */
  canWrite: boolean;
  canManage: boolean;
}

const Ctx = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProject outside a project');
  return v;
}

/** Sections of a project, added to as phase 7 lands. */
export const projectNav: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  { to: '', label: 'Overview', icon: <LayoutDashboard size={18} />, end: true },
  { to: 'locations', label: 'Locations', icon: <MapPin size={18} /> },
  { to: 'devices', label: 'Devices', icon: <Server size={18} /> },
  { to: 'ipam', label: 'IP addresses', icon: <Network size={18} /> },
  { to: 'vlans', label: 'VLANs and Wi-Fi', icon: <Waypoints size={18} /> },
  { to: 'templates', label: 'Templates', icon: <LayoutTemplate size={18} /> },
  { to: 'settings', label: 'Settings', icon: <Settings size={18} /> },
];

export function Shell() {
  const { projectId } = useParams();
  const pid = projectId ? Number(projectId) : undefined;
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const [theme, setTheme] = useState(currentTheme());
  const projects = useLoad(() => api.get<Project[]>('/api/projects'), []);
  const project = projects.data?.find((p) => p.id === pid);
  // A project created or granted since the list was loaded: fetch it again
  // (once per project id).
  const retried = useRef<number | null>(null);
  useEffect(() => {
    if (pid !== undefined && projects.data && !project && retried.current !== pid) {
      retried.current = pid;
      projects.reload();
    }
  }, [pid, projects.data, project, projects]);
  const rights = pid ? projectRights(me, pid) : { write: false, manage: false };

  let body: ReactNode = <Outlet />;
  if (pid !== undefined) {
    if ((projects.loading && !projects.data) || (!project && retried.current !== pid)) body = <Spinner />;
    else if (!project) body = <ErrorBox error={projects.error || 'That project doesn’t exist or you can’t see it.'} />;
    else
      body = (
        <Ctx.Provider
          value={{ project, projects: projects.data ?? [], reloadProjects: projects.reload, canWrite: rights.write, canManage: rights.manage }}
        >
          <Outlet />
        </Ctx.Provider>
      );
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-brand">
          <img src="/favicon.svg" alt="" />
          <span>Rackpath</span>
        </div>
        <div className="rail-project">
          <select
            className="input"
            aria-label="Project"
            value={pid ?? ''}
            onChange={(e) => nav(e.target.value ? `/p/${e.target.value}` : '/projects')}
          >
            <option value="">All projects…</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <nav className="rail-nav">
          {project && (
            <>
              <div className="rail-group u-label">{project.code}</div>
              {projectNav.map((n) => (
                <NavLink key={n.label} to={`/p/${project.id}${n.to ? `/${n.to}` : ''}`} end={n.end} className="rail-link">
                  {n.icon}
                  <span>{n.label}</span>
                </NavLink>
              ))}
            </>
          )}
          <div className="rail-group u-label">Rackpath</div>
          <NavLink to="/projects" className="rail-link" end>
            <FolderKanban size={18} />
            <span>Projects</span>
          </NavLink>
          {me?.is_account_admin && (
            <NavLink to="/admin/users" className="rail-link">
              <Users size={18} />
              <span>Users</span>
            </NavLink>
          )}
          <NavLink to="/activity" className="rail-link">
            <History size={18} />
            <span>Activity</span>
          </NavLink>
        </nav>
        <div className="rail-foot">
          <NavLink to="/account" className="rail-link">
            <UserCircle2 size={18} />
            <span>{me?.user.display_name || me?.user.username}</span>
          </NavLink>
          <button
            className="rail-link btn-ghost"
            style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit' }}
            onClick={() => {
              const t = theme === 'dark' ? 'light' : 'dark';
              applyTheme(t);
              setTheme(t);
            }}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
          <button
            className="rail-link"
            style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit' }}
            onClick={() => logout().then(() => nav('/'))}
          >
            <LogOut size={18} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <Search projectId={pid} />
        </div>
        <main className="content">{body}</main>
      </div>
    </div>
  );
}
