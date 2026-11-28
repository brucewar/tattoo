// Run before styles and React. This external, same-origin script respects the app CSP.
(function () {
  var preference = 'system';
  try {
    var stored = localStorage.getItem('tattoo:theme');
    if (stored === 'light' || stored === 'dark') preference = stored;
  } catch (_) {
    /* Storage may be unavailable. */
  }
  var dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var resolved = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    .setAttribute('content', dark ? '#191a1c' : '#ffffff');
})();
