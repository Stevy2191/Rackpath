import React, { useEffect, useRef, useState } from 'react';
import { useProject, DEFAULT_PROJECT_ID } from './ProjectContext';
import './ProjectSwitcher.css';

const DELETE_WARNING =
  'This will permanently delete all devices, scans, topology, and racks in this project. This cannot be undone.';

export default function ProjectSwitcher() {
  const {
    projects,
    currentProject,
    switchProject,
    createProject,
    updateProject,
    deleteProject,
  } = useProject();

  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(null); // null | { mode: 'create' | 'edit', project }
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const openCreate = () => {
    setOpen(false);
    setModal({ mode: 'create', project: null });
    setName('');
    setDescription('');
    setError(null);
  };

  const openEdit = (project) => {
    setOpen(false);
    setModal({ mode: 'edit', project });
    setName(project.name || '');
    setDescription(project.description || '');
    setError(null);
  };

  const closeModal = () => {
    setModal(null);
    setError(null);
    setSaving(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (modal.mode === 'create') {
        await createProject({ name: name.trim(), description: description.trim() || null });
      } else {
        await updateProject(modal.project.id, {
          name: name.trim(),
          description: description.trim() || null,
        });
      }
      closeModal();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!modal?.project) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(DELETE_WARNING)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteProject(modal.project.id);
      closeModal();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  return (
    <div className="project-switcher" ref={containerRef}>
      <button
        type="button"
        className="project-switcher-button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="project-switcher-label">{currentProject?.name || 'Select project'}</span>
        <span className={`project-switcher-chevron${open ? ' open' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="project-switcher-menu" role="listbox">
          <div className="project-switcher-list">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`project-switcher-item${
                  project.id === currentProject?.id ? ' active' : ''
                }`}
              >
                <button
                  type="button"
                  className="project-switcher-item-name"
                  onClick={() => {
                    switchProject(project.id);
                    setOpen(false);
                  }}
                >
                  {project.name}
                </button>
                <button
                  type="button"
                  className="project-switcher-item-settings"
                  title="Project settings"
                  aria-label={`Settings for ${project.name}`}
                  onClick={() => openEdit(project)}
                >
                  ⚙
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <div className="project-switcher-empty">No projects</div>
            )}
          </div>
          <button type="button" className="project-switcher-new" onClick={openCreate}>
            + New Project
          </button>
        </div>
      )}

      {modal && (
        <div className="project-modal-overlay" onMouseDown={closeModal}>
          <div className="project-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{modal.mode === 'create' ? 'New Project' : 'Project Settings'}</h3>
            <form onSubmit={handleSave}>
              <label>
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Project name"
                  autoFocus
                />
              </label>
              <label>
                Description (optional)
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this project for?"
                  rows={3}
                />
              </label>

              {error && <div className="project-modal-error">{error}</div>}

              <div className="project-modal-actions">
                {modal.mode === 'edit' && modal.project.id !== DEFAULT_PROJECT_ID && (
                  <button
                    type="button"
                    className="project-modal-delete"
                    onClick={handleDelete}
                    disabled={saving}
                  >
                    Delete Project
                  </button>
                )}
                <div className="project-modal-actions-right">
                  <button type="button" onClick={closeModal} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="project-modal-save" disabled={saving}>
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
