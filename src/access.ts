import './ui/access.css';

export interface RoomAdmission {
  roomId: string; code: string; teamSize: number; expiresAt: number;
  canCreate: boolean; owner: boolean; inviteUrl?: string;
}
export const accessState: { access: 'none' | 'password' | 'invite'; room?: RoomAdmission } = { access: 'none' };
export async function roomApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/game/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The room service is unavailable.');
  return data as T;
}
const app = document.getElementById('app')!;
app.hidden = true; document.getElementById('hud')!.hidden = true;
const gate = document.createElement('main'); gate.className = 'access-gate';
gate.innerHTML = `<section class="access-card" aria-labelledby="access-title">
  <div class="access-mark" aria-hidden="true">CS</div>
  <h1 id="access-title">Log into Car Soccer</h1>
  <p class="access-description">Enter the game password to play.</p>
  <form><label for="game-password">Game password</label><input id="game-password" type="password" autocomplete="current-password" required maxlength="256" autofocus />
  <button type="submit">Log in <span aria-hidden="true">→</span></button></form>
  <p class="access-status" role="status" aria-live="polite">Checking access…</p>
  <p class="access-note">Have an invite? An active room link takes you straight to your friends.</p>
</section>`;
document.body.appendChild(gate);
const form = gate.querySelector('form')!;
const field = gate.querySelector('input')!;
const button = gate.querySelector('button')!;
const status = gate.querySelector('.access-status')!;
let busy = true;
function message(value: string) { status.textContent = value; }
async function boot(): Promise<void> {
  message(accessState.room ? 'Joining your room…' : 'Opening the arena…');
  // Admission is complete. Give the renderer a measurable container while the
  // gate covers startup; hidden containers produce zero-sized render targets.
  app.hidden = false;
  const game = await import('./main'); await game.ready; gate.remove();
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  busy = true; button.disabled = true; message('Checking password…');
  try {
    await roomApi('login', { password: field.value }); field.value = '';
    sessionStorage.removeItem('car-room-replaced');
    Object.assign(accessState, await roomApi('status')); await boot();
  } catch (error) { message(error instanceof Error ? error.message : 'Unable to enter the game.'); }
  finally { field.value = ''; busy = false; button.disabled = false; }
});
async function enter(): Promise<void> {
  const early = window as unknown as { __carInviteRequest?: Promise<Response> };
  const inviteRequest = early.__carInviteRequest;
  delete early.__carInviteRequest;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const invite = fragment.get('join');
  // Consume invite before loading game code or optional third-party signalling. Never persist it.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  button.disabled = true;
  try {
    if (!inviteRequest && invite === null && sessionStorage.getItem('car-room-replaced')) {
      message('Your room is open in another tab. Use that tab, or enter the password.'); return;
    }
    sessionStorage.removeItem('car-room-replaced');
    if (inviteRequest || invite !== null) {
      let room: RoomAdmission;
      if (inviteRequest) {
        const response = await inviteRequest; const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'This invite is unavailable. Ask for a new link.');
        room = data;
      } else room = await roomApi<RoomAdmission>('invite', { token: invite });
      Object.assign(accessState, await roomApi('status'), { room });
    } else Object.assign(accessState, await roomApi('status'));
    if (accessState.access !== 'none') { await boot(); return; }
    message(sessionStorage.getItem('car-access-notice') ?? '');
    sessionStorage.removeItem('car-access-notice');
  } catch (error) { message(error instanceof Error ? error.message : 'The room service is unavailable.'); }
  finally { busy = false; button.disabled = false; field.focus(); }
}
void enter();
