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

function setInstallMessage(message) {
  if (installStatus) installStatus.textContent = message;
  if (toast) {
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(installTimer);
    installTimer = window.setTimeout(() => toast.classList.remove('show'), 3600);
  }
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
    if (installStatus) installStatus.textContent = 'The app is ready on your device.';
  });

  installButton.addEventListener('click', async () => {
    if (installButton.disabled) return;
    installButton.classList.add('is-loading');
    installButton.disabled = true;
    installButton.setAttribute('aria-busy', 'true');
    installButton.setAttribute('aria-label', 'Preparing app installation');

    if (!installPrompt) {
      setInstallMessage('Checking install options…');
      window.setTimeout(() => {
        finishInstall();
        const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
        if (isAppleMobile) {
          setInstallMessage('To install: tap Share, then choose Add to Home Screen.');
        } else {
          setInstallMessage('If available, choose Install app from your browser menu.');
        }
      }, 900);
      return;
    }

    try {
      const promptEvent = installPrompt;
      installPrompt = null;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        setInstallMessage('Installing app… Please wait.');
        window.clearTimeout(installTimer);
        installTimer = window.setTimeout(() => {
          finishInstall();
          setInstallMessage('If installation finished, open the app from your home screen.');
        }, 15000);
      } else {
        finishInstall();
        setInstallMessage('Installation cancelled. You can try again anytime.');
      }
    } catch {
      finishInstall();
      setInstallMessage('Could not start installation. Try your browser menu.');
    }
  });
}
