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
      : 'Scopely is invite-only during early access. New here? The owner of your workspace sends you a link; open it to set your password.' }),
    SESSION.info?.openSignup ? h('a', { class: 'auth-link', href: '#/join' }, 'Create a workspace') : null);
  email.input.focus();
}

/**
 * The invite token in what the address bar holds after #/join, or why there is none. Links pasted
 * through chat apps and notes often pick up a trailing full stop, bracket or quote, or a space;
 * those are not part of a token (it is 43 letters, digits, - and _), so they are dropped.
 */
export function readInviteToken(raw) {
  let v = raw ?? '';
  try { v = decodeURIComponent(v); } catch { /* keep as typed */ }
  v = v.replace(/^\/+/, '').trim().replace(/[\s.,;:!?)\]}>"'`]+$/, '');
  if (!v) return { problem: 'missing' };
  if (/^[A-Za-z0-9_-]{43}$/.test(v)) return { token: v };
  if (/^[A-Za-z0-9_-]+$/.test(v)) return { problem: v.length < 43 ? 'short' : 'long', length: v.length };
  return { problem: 'garbled' };
}

/** True when an email could be the one a masked hint ("o•••••@g•••.com") stands for. */
export function emailFitsHint(email, hint) {
  if (!hint) return true;
  const m = /^(.)•+@(.)•+(\..*)?$/.exec(hint);
  const e = String(email).trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (!m || at < 1) return true;
  const domain = e.slice(at + 1);
  return e[0] === m[1] && domain[0] === m[2] && (!m[3] || domain.endsWith(m[3]));
}

const PROBLEM = {
  missing: ['This invite link is incomplete', 'The link ends at /join/ with nothing after it, so it holds no invite. The person who invited you needs to send the full link again; it is a long code after /join/.'],
  short: ['This invite link was cut off', 'The code after /join/ is shorter than an invite code. Copy the whole link again, or ask for it to be re-sent.'],
  long: ['This invite link has extra characters', 'The code after /join/ is longer than an invite code. Copy the link again without anything added after it.'],
  garbled: ['This invite link was changed', 'The code after /join/ has characters an invite never has. Copy the link again exactly as it was sent.'],
};

export async function joinView(rawToken, after) {
  const read = rawToken === null && SESSION.info?.openSignup ? { token: null } : readInviteToken(rawToken);
  const signIn = h('a', { class: 'auth-link', href: '#/' }, SESSION.info?.signedIn ? 'Open Scopely' : 'Go to sign in');
  if (read.problem) {
    if (rawToken === null) {
      frame('Invite needed', 'Scopely is invite-only during early access: the owner of a workspace sends each person a link. Ask yours for one.', signIn);
    } else frame(...PROBLEM[read.problem], signIn);
    return;
  }
  const token = read.token;
  if (token && location.hash !== `#/join/${token}`) history.replaceState(null, '', `/app/#/join/${token}`);
  let invite = null;
  if (token) {
    try { invite = await api('POST', '/invites/check', { token }); } catch (err) {
      const title = /already been used/.test(err.message) ? 'Invite already used' : /expired/.test(err.message) ? 'Invite expired'
        : /closed/.test(err.message) ? 'Setup is already done' : /withdrawn/.test(err.message) ? 'Invite withdrawn' : 'Invite not valid';
      frame(title, err.message, signIn);
      return;
    }
  }
  if (SESSION.info?.signedIn) {
    const who = SESSION.info.user?.email ?? 'an account';
    frame('You are already signed in', `You are signed in as ${who}. To use this invite with a different account, sign out first, then open the link again.`,
      h('a', { class: 'btn', href: '#/' }, 'Open Scopely'),
      h('button', { class: 'auth-link linklike', type: 'button', onclick: () => signOutTo(`/app/#/join/${token}`) }, 'Sign out and use this invite'));
    return;
  }
  const setup = !invite || invite.kind === 'setup';
  const name = field('Your name', { type: 'text', autocomplete: 'name', maxlength: 120 });
  name.input.required = false;
  const email = field('Email', { type: 'email', autocomplete: 'email', maxlength: 254, autocapitalize: 'none', spellcheck: 'false' });
  const hint = invite?.emailHint ?? null;
  if (hint) email.el.append(h('small', { class: 'auth-hint', text: `This invite is for ${hint}. Type that address: check that your browser did not fill in a different one.` }));
  const password = field('Password (12 characters or more)', { type: 'password', autocomplete: 'new-password', minlength: 12, maxlength: 256 });
  const ws = setup ? field('Workspace name', { type: 'text', maxlength: 80, placeholder: 'Your business name' }) : null;
  frame(setup ? 'Create your workspace' : `Join ${invite.workspaceName}`,
    setup ? 'You will be its owner. Everything you find, build and record stays in this workspace, and only people you invite can see it.'
      : `You are invited as ${invite.role === 'member' ? 'a member' : `an ${invite.role}`}. If you already have an account, use its password.`,
    form(async () => {
      if (!emailFitsHint(email.input.value, hint)) throw new Error(`That is not the invited address (${hint}). Your browser may have filled in a different email.`);
      await api('POST', '/signup', { invite: token || undefined, email: email.input.value, password: password.input.value, name: name.input.value,
        workspaceName: ws ? ws.input.value : undefined });
      await loadSession(true);
      // The token leaves the address bar and the history entry once it is used.
      history.replaceState(null, '', '/app/#/');
      after();
    }, [name, email, password, ws].filter(Boolean), setup ? 'Create workspace' : 'Join workspace'),
    h('a', { class: 'auth-link', href: '#/' }, 'I already have an account'));
  (hint ? email.input : name.input).focus();
}

async function signOutTo(target) {
  try { await api('DELETE', '/session'); } catch (err) { return fail(err); }
  SESSION.info = null;
  location.replace(target);
  location.reload();
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
  const switcher = () => s.workspaces.length > 1
    ? h('select', { class: 'sh-wsel', 'aria-label': 'Workspace', onchange: async (e) => {
        try { await api('POST', '/session/workspace', { workspaceId: e.target.value }); location.replace('/app/#/'); location.reload(); } catch (err) { fail(err); }
      } }, s.workspaces.map((w) => h('option', { value: w.workspaceId, selected: s.workspace?.workspaceId === w.workspaceId }, w.name)))
    : h('span', { text: s.workspace?.name ?? 'No workspace' });
  const canInvite = s.workspace && (s.workspace.role === 'owner' || s.workspace.role === 'admin');
  const controls = () => [canInvite ? h('button', { class: 'btn sm ghost', onclick: invite }, 'Invite') : null,
    h('button', { class: 'btn sm ghost', onclick: signOut }, 'Sign out')];
  // Wide screens show everything inline; narrow ones fold it into an Account menu.
  return [h('span', { class: 'sh-acct' }, switcher(), ...controls().slice(0, 1), h('span', { class: 'sh-user', title: s.user.email, text: s.user.name || s.user.email }), ...controls().slice(1)),
    h('details', { class: 'sh-acctm' }, h('summary', { class: 'btn sm', 'aria-label': 'Account' }, 'Account'),
      h('div', { class: 'sh-acctm-p' }, h('b', { text: s.user.name || s.user.email }), h('small', { text: s.user.email }),
        switcher(), ...controls()))];
}
