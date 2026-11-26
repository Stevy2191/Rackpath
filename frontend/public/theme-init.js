// Applies the saved light/dark theme before first paint to avoid a flash.
// Kept as a file (not inline) so the Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var stored = localStorage.getItem('rackpath-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
