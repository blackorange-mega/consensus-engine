const dot = document.getElementById('dot');
const status = document.getElementById('status');
const engine = document.getElementById('engine');
const token = document.getElementById('token');

async function refresh() {
  const stored = await chrome.storage.local.get(['engineUrl', 'token']);
  engine.value = stored.engineUrl || 'ws://127.0.0.1:8787/relay';
  token.value = stored.token || '';

  chrome.runtime.sendMessage({ type: 'relay:status' }, (res) => {
    if (!res) {
      status.textContent = 'service worker not responding';
      return;
    }
    if (res.killed) {
      dot.className = 'dot off';
      status.textContent = 'kill switch engaged';
      return;
    }
    dot.className = `dot ${res.connected ? 'on' : ''}`;
    status.textContent = res.connected
      ? `connected · pack ${res.packVersion} · ${res.providers.length} provider(s)`
      : 'not connected';
  });
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ engineUrl: engine.value.trim(), token: token.value.trim() });
  chrome.runtime.sendMessage({ type: 'relay:reconnect' }, () => setTimeout(refresh, 600));
});

refresh();
