// Sign-in (A40): the sign-in and join screens, and the account controls in the top bar. The server
// decides everything: who is signed in, which workspaces they belong to, and what each one may do.
// The browser keeps no token; the session is an HttpOnly cookie it cannot read.
//
// Routes: #/join/<token> accepts an invite. Any other route shows sign-in while signed out.
import { $app, api, fail, h, toast } from './lib.js';

/** What GET /api/session said last: { mode: 'session' | 'preview', signedIn, user, workspace, workspaces, openSignup }. */
export const SESSION = { info: null };

export async function loadSession(force = false) {
  if (!SESSION.info || force) SESSION.info = await api('GET', '/session');
  return SESSION.info;
}

/** True when this route needs the sign-in or join screen instead. */
export const needsSignIn = () => SESSION.info?.mode === 'session' && !SESSION.info.signedIn;

function frame(title, sub, ...kids) {
  document.title = `Scopely · ${title}`;
  $app.replaceChildren(h('main', { class: 'auth' },
    h('a', { class: 'logo', href: '/' }, h('i'), 'SCOPELY'),
    h('section', { class: 'auth-card', 'aria-labelledby': 'auth-h' }, h('h1', { id: 'auth-h', text: title }), sub ? h('p', { class: 'auth-sub', text: sub }) : null, ...kids)));
}

const field = (label, props) => {
  const input = h('input', { ...props, required: true });
  return { input, el: h('label', { class: 'auth-f' }, h('span', { text: label }), input) };
};

function form(onSubmit, fields, button) {
  const err = h('p', { class: 'auth-err', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, button);
  const f = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try { await onSubmit(); } catch (x) { err.textContent = x.message; err.hidden = false; } finally { btn.disabled = false; }
    },
  }, fields.map((x) => x.el), err, btn);
  return f;
}

export function signInView(after) {
  const email = field('Email', { type: 'email', autocomplete: 'username', maxlength: 254 });
  const password = field('Password', { type: 'password', autocomplete: 'current-password', maxlength: 256 });
  frame('Sign in', 'Use the email and password you joined with.',
    form(async () => {
      await api('POST', '/session', { email: email.input.value, password: password.input.value });
      await loadSession(true);
      after();
    }, [email, password], 'Sign in'),
    h('p', { class: 'auth-foot', text: SESSION.info?.openSignup
      ? 'New here? Open an invite link, or create a workspace below.'
      : 'New to Scopely? Ask a workspace owner for an invite link.' }),
    SESSION.info?.openSignup ? h('a', { class: 'auth-link', href: '#/join' }, 'Create a workspace') : null);
  email.input.focus();
}

export async function joinView(token, after) {
  let invite = null;
  if (token) {
    try { invite = await api('POST', '/invites/check', { token }); } catch (err) {
      frame('Invite not valid', err.message, h('a', { class: 'auth-link', href: '#/' }, 'Go to sign in'));
      return;
    }
  } else if (!SESSION.info?.openSignup) {
    frame('Invite needed', 'Scopely is invite-only. Ask a workspace owner for an invite link.', h('a', { class: 'auth-link', href: '#/' }, 'Go to sign in'));
    return;
  }
  const setup = !invite || invite.kind === 'setup';
  const name = field('Your name', { type: 'text', autocomplete: 'name', maxlength: 120 });
  name.input.required = false;
  const email = field('Email', { type: 'email', autocomplete: 'username', maxlength: 254 });
  const password = field('Password (12 characters or more)', { type: 'password', autocomplete: 'new-password', minlength: 12, maxlength: 256 });
  const ws = setup ? field('Workspace name', { type: 'text', maxlength: 80, placeholder: 'Your business name' }) : null;
  frame(setup ? 'Create your workspace' : `Join ${invite.workspaceName}`,
    setup ? 'You will be its owner. Everything you find, build and record stays in this workspace.'
      : `You are invited as ${invite.role === 'member' ? 'a member' : `an ${invite.role}`}. If you already have an account, use its password.`,
    form(async () => {
      await api('POST', '/signup', { invite: token || undefined, email: email.input.value, password: password.input.value, name: name.input.value,
        workspaceName: ws ? ws.input.value : undefined });
      await loadSession(true);
      history.replaceState(null, '', '/app/#/');
      after();
    }, [name, email, password, ws].filter(Boolean), setup ? 'Create workspace' : 'Join workspace'),
    h('a', { class: 'auth-link', href: '#/' }, 'I already have an account'));
}

async function signOut() {
  try { await api('DELETE', '/session'); } catch (err) { return fail(err); }
  SESSION.info = null;
  location.replace('/app/#/');
  location.reload();
}

async function invite() {
  const role = prompt('Invite someone to this workspace. Role: member or admin?', 'member');
  if (role === null) return;
  const email = prompt('Their email (optional, recommended: the link then only works for them)', '') ?? '';
  try {
    const r = await api('POST', '/workspace/invites', { role: role.trim().toLowerCase(), email: email.trim() || undefined });
    const link = `${location.origin}${r.url}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied. Send it yourself; Scopely sends no email. It works once, for 7 days.'); }
    catch { prompt('Copy this invite link. It works once, for 7 days:', link); }
  } catch (err) { fail(err); }
}

/** The account controls for the top bar: workspace, person, invite and sign out; or the preview label. */
export function accountBar() {
  const s = SESSION.info;
  if (!s || s.mode === 'preview') {
    return [s?.workspace ? h('span', { text: s.workspace.name }) : null,
      h('span', { class: 'sh-auth', title: 'Development preview: this server acts in one workspace with no sign-in. Never used in production.', text: 'Development preview' })];
  }
  if (!s.signedIn) return [];
  const switcher = s.workspaces.length > 1
    ? h('select', { class: 'sh-wsel', 'aria-label': 'Workspace', onchange: async (e) => {
        try { await api('POST', '/session/workspace', { workspaceId: e.target.value }); location.replace('/app/#/'); location.reload(); } catch (err) { fail(err); }
      } }, s.workspaces.map((w) => h('option', { value: w.workspaceId, selected: s.workspace?.workspaceId === w.workspaceId }, w.name)))
    : h('span', { text: s.workspace?.name ?? 'No workspace' });
  const canInvite = s.workspace && (s.workspace.role === 'owner' || s.workspace.role === 'admin');
  return [switcher,
    canInvite ? h('button', { class: 'btn sm ghost', onclick: invite }, 'Invite') : null,
    h('span', { class: 'sh-user', title: s.user.email, text: s.user.name || s.user.email }),
    h('button', { class: 'btn sm ghost', onclick: signOut }, 'Sign out')];
}
