import React from 'react';
import { NavLink } from 'react-router-dom';
import { Key } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import ProjectSwitcher from '../project/ProjectSwitcher';
import './Navbar.css';

const links = [
  { to: '/scan', label: 'Scan' },
  { to: '/topology', label: 'Topology' },
  { to: '/vlans', label: 'VLANs' },
  { to: '/racks', label: 'Racks' },
  { to: '/devices', label: 'Devices' },
  { to: '/macros', label: 'Macros', icon: Key },
  { to: '/integrations', label: 'Integrations' },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <nav className="navbar">
      <div className="navbar-left">
        <div className="navbar-brand">Rackpath</div>
        <ProjectSwitcher />
      </div>
      <div className="navbar-links">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => `navbar-link${isActive ? ' active' : ''}`}
          >
            {link.icon && <link.icon size={14} className="navbar-link-icon" />}
            {link.label}
          </NavLink>
        ))}
      </div>
      <div className="navbar-user">
        <button
          className="navbar-theme-toggle"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle dark mode"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        {user && <span className="navbar-username">{user.username}</span>}
        <button className="navbar-logout" onClick={logout}>
          Logout
        </button>
      </div>
    </nav>
  );
}
