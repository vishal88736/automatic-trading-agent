let csrf = '';
let initializing: Promise<void> | null = null;

async function session() {
  if (!initializing) initializing = fetch('/api/session', { method: 'POST', credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('Could not establish a local terminal session.');
    csrf = (await response.json()).csrf_token;
  }).catch(error => { initializing = null; throw error; });
  await initializing;
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  await session();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Terminal-CSRF': csrf }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? `Request failed (${response.status})`);
    return data as T;
  } finally { window.clearTimeout(timeout); }
}
