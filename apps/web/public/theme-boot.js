(function () {
  var saved = null;
  try { saved = localStorage.getItem('hive-theme'); } catch (e) {}
  var theme = saved === 'light' || saved === 'dark'
    ? saved
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  var cs = document.querySelector('meta[name="color-scheme"]');
  var tc = document.querySelector('meta[name="theme-color"]');
  if (cs) cs.setAttribute('content', theme);
  if (tc) tc.setAttribute('content', theme === 'light' ? '#F4F6FB' : '#0B0D11');
})();