if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

const installButton = document.getElementById('install-app');
const installStatus = document.getElementById('install-status');
const toast = document.getElementById('toast');
let installPrompt = null;
let installTimer = null;

function setInstallHint(message) {
  if (installStatus) installStatus.textContent = message;
}

function finishInstall(label = 'Install App') {
  if (!installButton) return;
  installButton.classList.remove('is-loading');
  installButton.disabled = false;
  installButton.querySelector('.install-label').textContent = label;
  installButton.setAttribute('aria-label', label);
  installButton.removeAttribute('aria-busy');
}

if (installButton) {
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) {
    installButton.classList.add('is-installed');
    installButton.disabled = true;
    installButton.querySelector('.install-icon').textContent = '✓';
    installButton.querySelector('.install-label').textContent = 'App Installed';
    installButton.setAttribute('aria-label', 'App installed');
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
  });

  window.addEventListener('appinstalled', () => {
    window.clearTimeout(installTimer);
    if (toast) toast.classList.remove('show');
    installButton.classList.remove('is-loading');
    installButton.classList.add('is-installed');
    installButton.disabled = true;
    installButton.querySelector('.install-icon').textContent = '✓';
    installButton.querySelector('.install-label').textContent = 'App Installed';
    installButton.setAttribute('aria-label', 'App installed');
    installButton.removeAttribute('aria-busy');
    if (installStatus) installStatus.textContent = '';
  });

  installButton.addEventListener('click', async () => {
    if (installButton.disabled) return;
    if (installStatus) installStatus.textContent = '';
    if (toast) toast.classList.remove('show');
    installButton.classList.add('is-loading');
    installButton.disabled = true;
    installButton.setAttribute('aria-busy', 'true');
    installButton.setAttribute('aria-label', 'Preparing app installation');

    if (!installPrompt) {
      const ua = navigator.userAgent;
      window.setTimeout(() => {
        finishInstall();
        if (/iphone|ipad|ipod/i.test(ua)) {
          setInstallHint('On iPhone/iPad: Share → Add to Home Screen.');
        } else if (/android/i.test(ua)) {
          setInstallHint('Install prompt unavailable. In Chrome, open ⋮ → Install app.');
        } else {
          setInstallHint('Use your browser menu to install this app.');
        }
      }, 700);
      return;
    }

    try {
      const promptEvent = installPrompt;
      installPrompt = null;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        window.clearTimeout(installTimer);
        installTimer = window.setTimeout(() => {
          finishInstall();
        }, 15000);
      } else {
        finishInstall();
      }
    } catch {
      finishInstall();
      setInstallHint('Install prompt unavailable. Try your browser menu.');
    }
  });
}
