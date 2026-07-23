(() => {
  const steps = {
    idle: document.getElementById('gate-idle'),
    checking: document.getElementById('gate-checking'),
    allowed: document.getElementById('gate-allowed'),
    denied: document.getElementById('gate-denied'),
    error: document.getElementById('gate-error')
  };

  function show(stepName) {
    Object.values(steps).forEach((el) => el.classList.add('hidden'));
    steps[stepName].classList.remove('hidden');
  }

  async function checkLocation() {
    show('checking');

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const res = await fetch('/api/verify-location', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude })
            });
            const data = await res.json();
            handleResult(data.allowed, `~${data.distanceKm}km from central Duhok`);
          } catch (e) {
            fallbackToIp();
          }
        },
        () => fallbackToIp(),
        { timeout: 8000 }
      );
    } else {
      fallbackToIp();
    }
  }

  async function fallbackToIp() {
    try {
      const res = await fetch('/api/ip-check');
      const data = await res.json();
      handleResult(data.allowed, data.city ? `matched by network location (${data.city})` : 'matched by network location');
    } catch (e) {
      show('error');
    }
  }

  function handleResult(allowed, note) {
    if (allowed) {
      document.getElementById('distance-note').textContent = note;
      show('allowed');
    } else {
      document.getElementById('denied-detail').textContent =
        `Your location came back outside the Duhok area (${note}), so we can't let you in right now. Chtkeey is built to keep the room genuinely local.`;
      show('denied');
    }
  }

  document.getElementById('btn-check-location').addEventListener('click', checkLocation);
  document.getElementById('btn-retry').addEventListener('click', () => show('idle'));
  document.getElementById('btn-retry-error').addEventListener('click', checkLocation);

  const nicknameInput = document.getElementById('nickname');
  const ageCheckbox = document.getElementById('agree-age');
  const enterBtn = document.getElementById('btn-enter');

  function refreshEnterState() {
    enterBtn.disabled = !(nicknameInput.value.trim().length >= 2 && ageCheckbox.checked);
  }
  nicknameInput.addEventListener('input', refreshEnterState);
  ageCheckbox.addEventListener('change', refreshEnterState);

  enterBtn.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim().slice(0, 20);
    sessionStorage.setItem('chtkeey_nickname', nickname);
    window.location.href = '/chat.html';
  });
})();
