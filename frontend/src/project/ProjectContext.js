import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import client, { setProjectId, PROJECT_STORAGE_KEY } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const ProjectContext = createContext(null);

export const DEFAULT_PROJECT_ID = 1;

function readStoredId() {
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    const id = parseInt(raw, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (err) {
    return null;
  }
}

function persistId(id) {
  setProjectId(id);
  try {
    if (id == null) localStorage.removeItem(PROJECT_STORAGE_KEY);
    else localStorage.setItem(PROJECT_STORAGE_KEY, String(id));
  } catch (err) {
    /* ignore storage failures */
  }
}

export function ProjectProvider({ children }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [currentProjectId, setCurrentProjectId] = useState(() => readStoredId());
  const [loading, setLoading] = useState(true);

  // Load the project list once the user is authenticated. Restore the last
  // selected project; if it no longer exists, fall back to the first one.
  useEffect(() => {
    if (!user) {
      setProjects([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    client
      .get('/projects')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res.data) ? res.data : [];
        setProjects(list);

        const stored = readStoredId();
        const exists = stored != null && list.some((p) => p.id === stored);
        const next = exists ? stored : list[0]?.id ?? DEFAULT_PROJECT_ID;
        persistId(next);
        setCurrentProjectId(next);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const switchProject = useCallback((id) => {
    persistId(id);
    setCurrentProjectId(id);
  }, []);

  const refreshProjects = useCallback(async () => {
    const res = await client.get('/projects');
    const list = Array.isArray(res.data) ? res.data : [];
    setProjects(list);
    return list;
  }, []);

  const createProject = useCallback(
    async ({ name, description }) => {
      const res = await client.post('/projects', { name, description });
      await refreshProjects();
      // Switch to the newly created project so the user lands in it.
      switchProject(res.data.id);
      return res.data;
    },
    [refreshProjects, switchProject]
  );

  const updateProject = useCallback(
    async (id, updates) => {
      const res = await client.patch(`/projects/${id}`, updates);
      setProjects((prev) => prev.map((p) => (p.id === id ? res.data : p)));
      return res.data;
    },
    []
  );

  const deleteProject = useCallback(
    async (id) => {
      await client.delete(`/projects/${id}`);
      const list = await refreshProjects();
      // If the deleted project was active, fall back to another project.
      setCurrentProjectId((prev) => {
        if (prev !== id) return prev;
        const next = list[0]?.id ?? DEFAULT_PROJECT_ID;
        persistId(next);
        return next;
      });
    },
    [refreshProjects]
  );

  const currentProject =
    projects.find((p) => p.id === currentProjectId) || null;

  return (
    <ProjectContext.Provider
      value={{
        projects,
        currentProject,
        currentProjectId,
        loading,
        switchProject,
        createProject,
        updateProject,
        deleteProject,
        refreshProjects,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
