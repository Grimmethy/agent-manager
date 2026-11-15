function wireProviderToggle(idAttr) {
  const btn = document.getElementById(idAttr);
  if (!btn) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    const next = btn.dataset.provider === 'local' ? 'claude' : 'local';
    providerChoices[idAttr] = next;
    btn.dataset.provider = next;
    btn.textContent = next === 'local' ? 'Local' : 'Claude';
    btn.classList.toggle('provider-toggle-claude', next === 'claude');
  };
}

function providerPayload(idAttr) {
  const btn = document.getElementById(idAttr);
  return { provider: (btn && btn.dataset.provider) || 'local' };
}
