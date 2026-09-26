// Dynamic email sign-in for the web-app, exposed as `window.evabobDynamic`.
//
// The phones use the Dynamic Flutter SDK; in the browser the same Dart code
// (mobile/lib/core/auth/dynamic_client_web.dart) calls these functions.
//
// - Every function resolves to a JSON string, `{ok:true,...}` or
//   `{ok:false,error}`, so Dart sees Dynamic's own error wording.
// - Dynamic's state is kept in sessionStorage: closing the tab signs out.
// - verifyEmailOtp returns the *full* JWT from the verify response. The SDK
//   itself keeps only the minified token, which has no verified credentials
//   and is refused by the Evabob server.

import {
  createDynamicClient,
  initializeClient,
  logout as dynamicLogout,
  sendEmailOTP,
  verifyOTP,
} from '@dynamic-labs-sdk/client';

const sessionStore = {
  getItem: async (key) => window.sessionStorage.getItem(key),
  setItem: async (key, value) => window.sessionStorage.setItem(key, value),
  removeItem: async (key) => window.sessionStorage.removeItem(key),
};

let client = null;
let starting = null;
let pendingEmail = null;
let otpVerification = null;

const ok = (extra = {}) => JSON.stringify({ ok: true, ...extra });

function errorText(e) {
  if (!e) return 'Sign-in failed';
  if (typeof e === 'string') return e;
  const parts = [e.code, e.message || e.error].filter(Boolean).map(String);
  return parts.length ? parts.join(': ') : String(e);
}

const fail = (e) => JSON.stringify({ ok: false, error: errorText(e) });

async function start(environmentId, appName) {
  if (!starting) {
    starting = (async () => {
      client = createDynamicClient({
        environmentId,
        autoInitialize: false,
        metadata: { name: appName, universalLink: window.location.origin },
        coreConfig: { storageAdapter: sessionStore },
      });
      await initializeClient(client);
    })().catch((e) => {
      starting = null;
      throw e;
    });
  }
  return starting;
}

async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

function emailOf(user) {
  if (!user) return null;
  if (user.email) return user.email;
  for (const c of user.verifiedCredentials || []) {
    if (c.format === 'email') {
      const e = c.email || c.publicIdentifier;
      if (e && e.includes('@')) return e;
    }
  }
  return null;
}

window.evabobDynamic = {
  init: (environmentId, appName) =>
    run(async () => {
      await start(environmentId, appName);
      return ok();
    }),

  sendEmailOtp: (email) =>
    run(async () => {
      if (!client) throw new Error('Sign-in is still loading');
      pendingEmail = email;
      otpVerification = await sendEmailOTP({ email }, client);
      return ok();
    }),

  resendEmailOtp: () =>
    run(async () => {
      if (!client) throw new Error('Sign-in is still loading');
      if (!pendingEmail) throw new Error('Enter your email first');
      otpVerification = await sendEmailOTP({ email: pendingEmail }, client);
      return ok();
    }),

  verifyEmailOtp: (code) =>
    run(async () => {
      if (!client) throw new Error('Sign-in is still loading');
      if (!otpVerification) {
        throw new Error('invalid_email_verification: please start again');
      }
      const res = await verifyOTP(
        { otpVerification, verificationToken: code },
        client,
      );
      const user = res.user || client.user || null;
      return ok({
        jwt: res.jwt || null,
        user: user
          ? {
              userId: user.userId || user.id || null,
              sessionId: user.sessionId || null,
              email: emailOf(user),
              phoneNumber: user.phoneNumber || null,
            }
          : null,
      });
    }),

  logout: () =>
    run(async () => {
      pendingEmail = null;
      otpVerification = null;
      if (client) await dynamicLogout(client);
      return ok();
    }),
};
