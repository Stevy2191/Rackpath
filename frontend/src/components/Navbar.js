import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Key, ChevronDown, LayoutDashboard } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { useProject, DEFAULT_PROJECT_ID } from '../project/ProjectContext';
import ProjectSwitcher from '../project/ProjectSwitcher';
import './Navbar.css';

const links = [
  { to: '/scan', label: 'Scan' },
  { to: '/topology', label: 'Topology' },
  { to: '/vlans', label: 'VLANs' },
  { to: '/racks', label: 'Racks' },
];

const afterLinks = [
  { to: '/macros', label: 'Macros', icon: Key },
  { to: '/network-tools', label: 'Network Tools' },
  { to: '/integrations', label: 'Integrations' },
];

const deviceLinks = [
  { to: '/devices', label: 'All Devices' },
  { to: '/devices/network', label: 'Network Devices' },
  { to: '/devices/cameras', label: 'Cameras' },
  { to: '/devices/access', label: 'Access Devices' },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { currentProjectId } = useProject();
  const location = useLocation();

  const isDevicesPath = location.pathname.startsWith('/devices');
  const [devicesOpen, setDevicesOpen] = useState(isDevicesPath);
  const devicesDropdownRef = useRef(null);

  useEffect(() => {
    if (isDevicesPath) setDevicesOpen(true);
  }, [isDevicesPath]);

  useEffect(() => {
    if (!devicesOpen) return;

    const handleClickOutside = (event) => {
      if (devicesDropdownRef.current && !devicesDropdownRef.current.contains(event.target)) {
        setDevicesOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [devicesOpen]);

  return (
    <nav className="navbar">
      <div className="navbar-left">
        <div className="navbar-brand">Rackpath</div>
        <ProjectSwitcher />
      </div>
      <div className="navbar-links">
        <NavLink
          to={`/projects/${currentProjectId ?? DEFAULT_PROJECT_ID}`}
          className={({ isActive }) => `navbar-link${isActive ? ' active' : ''}`}
        >
          <LayoutDashboard size={14} className="navbar-link-icon" />
          Dashboard
        </NavLink>
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

        <div className="navbar-dropdown" ref={devicesDropdownRef}>
          <button
            type="button"
            className={`navbar-link navbar-dropdown-toggle${isDevicesPath ? ' active' : ''}`}
            onClick={() => setDevicesOpen((v) => !v)}
          >
            Devices
            <ChevronDown size={14} className={`navbar-dropdown-chevron${devicesOpen ? ' open' : ''}`} />
          </button>
          {devicesOpen && (
            <div className="navbar-dropdown-menu">
              {deviceLinks.map((link) => {
                const active =
                  link.to === '/devices'
                    ? location.pathname === '/devices' || /^\/devices\/\d+$/.test(location.pathname)
                    : location.pathname === link.to;
                return (
                  <Link key={link.to} to={link.to} className={`navbar-dropdown-item${active ? ' active' : ''}`}>
                    {link.label}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {afterLinks.map((link) => (
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
