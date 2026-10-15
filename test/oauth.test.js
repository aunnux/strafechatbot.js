import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StrafeOAuth, StrafeOAuthError } from '../src/OAuth/OAuth.js';

function jsonResponse(body, { status = 200 } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function createOAuth(fetchImpl = async () => jsonResponse({})) {
    return new StrafeOAuth({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://example.com/callback',
        fetchImpl,
    });
}

test('authorization URL includes configured callback, scopes, and state', () => {
    const oauth = createOAuth();
    const url = new URL(oauth.getAuthorizationUrl({
        scope: ['identify', 'email'],
        state: 'session-state',
    }));

    assert.equal(url.origin, 'https://app.strafe.chat');
    assert.equal(url.pathname, '/oauth2/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'client-id');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/callback');
    assert.equal(url.searchParams.get('scope'), 'identify email');
    assert.equal(url.searchParams.get('state'), 'session-state');
});

test('authorization URL requires state', () => {
    assert.throws(() => createOAuth().getAuthorizationUrl(), /state/);
});

test('code exchange uses form encoding and authenticates with HTTP Basic', async () => {
    let request;
    const oauth = createOAuth(async (url, options) => {
        request = { url, options };
        return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token' });
    });

    const tokens = await oauth.exchangeCode('one-time-code');

    assert.equal(tokens.access_token, 'access-token');
    assert.equal(request.url.href, 'https://app.strafe.chat/api/oauth2/token');
    assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(request.options.body)), {
        grant_type: 'authorization_code',
        code: 'one-time-code',
        redirect_uri: 'https://example.com/callback',
    });
});

test('refresh and revoke send the required token fields', async () => {
    const requests = [];
    const oauth = createOAuth(async (url, options) => {
        requests.push({ url, body: Object.fromEntries(new URLSearchParams(options.body)) });
        return jsonResponse({});
    });

    await oauth.refreshToken('refresh-token');
    await oauth.revokeToken('access-token');

    assert.deepEqual(requests.map(({ url, body }) => ({
        path: new URL(url).pathname,
        body,
    })), [
        { path: '/api/oauth2/token', body: { grant_type: 'refresh_token', refresh_token: 'refresh-token' } },
        { path: '/api/oauth2/token/revoke', body: { token: 'access-token' } },
    ]);
});

test('user and token info requests use the bearer access token', async () => {
    const requests = [];
    const oauth = createOAuth(async (url, options) => {
        requests.push({ path: new URL(url).pathname, authorization: options.headers.Authorization });
        return jsonResponse({ id: 'user-id' });
    });

    await oauth.getUser('access-token');
    await oauth.getTokenInfo('access-token');
    await oauth.getUserSpaces('access-token');

    assert.deepEqual(requests, [
        { path: '/api/users/@me', authorization: 'Bearer access-token' },
        { path: '/api/oauth2/@me', authorization: 'Bearer access-token' },
        { path: '/api/users/@me/spaces', authorization: 'Bearer access-token' },
    ]);
});

test('non-success responses throw StrafeOAuthError with response details', async () => {
    const oauth = createOAuth(async () => jsonResponse({
        error: 'invalid_grant',
        error_description: 'Code has expired',
    }, { status: 400 }));

    await assert.rejects(oauth.exchangeCode('expired-code'), (error) => {
        assert.ok(error instanceof StrafeOAuthError);
        assert.equal(error.message, 'Code has expired');
        assert.equal(error.status, 400);
        assert.equal(error.body.error, 'invalid_grant');
        return true;
    });
});

test('generateState returns a unique URL-safe value', () => {
    const oauth = createOAuth();
    const first = oauth.generateState();
    const second = oauth.generateState();

    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
});
