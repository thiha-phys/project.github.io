const toast = document.getElementById('toast');
let toastTimer;

document.querySelectorAll('[data-subject]').forEach((button) => {
  button.addEventListener('click', () => {
    const subject = button.dataset.subject;
    toast.textContent = `The ${subject} project page is being prepared.`;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
  });
});
