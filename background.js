// Helper to promisify chrome.storage.session.get
/**
 * Promisifies chrome.storage.session.get for easier async/await usage
 * @param {string|Array|Object} key - Storage key(s) to retrieve
 * @returns {Promise<Object>} Promise that resolves with the storage result
 */
const getSession = (key) => {
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (result) => resolve(result));
  });
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
    return false;
  }

  // Handle Google Calendar token request synchronously
  if (message.action === 'getGoogleCalendarToken') {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        console.error('Google Calendar auth error:', chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError });
      } else {
        console.log('Google Calendar token obtained successfully');
        sendResponse({ success: true, token: token });
      }
    });
    return true; // Keep message channel open for async response
  }

  // Handle Outlook Calendar token request (authorization code flow with PKCE)
  if (message.action === 'getOutlookCalendarToken') {
    getOutlookToken()
      .then((token) => {
        console.log('Outlook Calendar token obtained successfully');
        sendResponse({ success: true, token });
      })
      .catch((err) => {
        console.error('Outlook Calendar auth error:', err);
        sendResponse({ success: false, error: { message: err.message } });
      });
    return true; // Keep message channel open for async response
  }

  if (message.action === 'newCarletonTempTab' && typeof message.login === 'string') {
    chrome.tabs.create({ url: message.login });
  } else if (message.action === 'clearGoogleToken' && typeof message.token === 'string') {
    chrome.identity.removeCachedAuthToken({ token: message.token });
  } else if (message.action === 'end-timetable-request') {
    chrome.storage.session.set({ 'timetable-requested': [false] });
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  (async () => {
    const result = await getSession(['timetable-requested']);
    const r = result['timetable-requested'];
    if (r && r[0]) {
      if (details.url === 'https://360.carleton.ca/urd/sits.urd/run/siw_lgn_logout.saml_logout') {
        chrome.tabs.update(details.tabId, { url: SSO_URL });
      }
      else {
        injectScript(details.tabId);
      }
    }
  })();
}, {
  url: [
    { hostContains: 'central.carleton.ca' },
    { urlEquals: 'https://360.carleton.ca/urd/sits.urd/run/siw_lgn_logout.saml_logout' }
  ]
});

const SSO_URL = 'https://ssoman.carleton.ca/ssomanager/c/SSB?pkg=bwskfshd.P_CrseSchd';
const EXPORT_SCRIPTS = ['src/schedule.js', 'src/carleton-parse.js', 'src/export.js', 'src/status-card.js', 'src/carleton.js'];

/**
 * Injects the export scripts into a Carleton Central tab
 * @param {number} tabId - ID of the target tab
 */
function injectScript(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, files: EXPORT_SCRIPTS });
}

const OUTLOOK_CLIENT_ID = '4e6fdfa3-e2e0-4893-a3c4-527ea3dd4ce4';
const OUTLOOK_SCOPE = 'https://graph.microsoft.com/Calendars.ReadWrite';
const MS_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';

const base64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomString = (byteLength) => base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

/**
 * Signs in to Microsoft with the authorization code flow + PKCE and returns a Graph access token.
 * Replaces the implicit flow (response_type=token), which Microsoft no longer recommends.
 * Requires the redirect URI to be registered under the "Single-page application" platform in Azure.
 * @returns {Promise<string>} access token
 */
async function getOutlookToken() {
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomString(64);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = randomString(32);

  const authUrl = `${MS_AUTHORITY}/authorize?` + new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: OUTLOOK_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
  });

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (err) {
    throw new Error(err?.message || 'Authentication cancelled by user');
  }
  if (!responseUrl) throw new Error('Authentication cancelled by user');

  const params = new URL(responseUrl).searchParams;
  if (params.get('error')) {
    throw new Error(params.get('error_description') || params.get('error'));
  }
  if (params.get('state') !== state) throw new Error('Sign-in response did not match the request (state mismatch)');
  const code = params.get('code');
  if (!code) throw new Error('No authorization code in sign-in response');

  const res = await fetch(`${MS_AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OUTLOOK_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: OUTLOOK_SCOPE,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token request failed: ${res.status}`);
  }
  return data.access_token;
}
