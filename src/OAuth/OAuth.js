import { randomBytes } from 'node:crypto';
import { parseResponseBody } from '../util/functions.js';

const DEFAULT_AUTHORIZE_URL = 'https://app.strafe.chat/oauth2/authorize';
const DEFAULT_API_BASE_URL = 'https://app.strafe.chat/api';

export class StrafeOAuthError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.name = 'StrafeOAuthError';
        this.status = status;
        this.body = body;
    }
}

export class StrafeOAuth {
    constructor({
        clientId,
        clientSecret,
        redirectUri,
        authorizeUrl = DEFAULT_AUTHORIZE_URL,
        apiBaseUrl = DEFAULT_API_BASE_URL,
        fetchImpl = globalThis.fetch,
    } = {}) {
        if (typeof clientId !== 'string' || !clientId.trim())
            throw new TypeError('A Strafe OAuth client ID is required');
        if (typeof clientSecret !== 'string' || !clientSecret.trim())
            throw new TypeError('A Strafe OAuth client secret is required');
        if (typeof redirectUri !== 'string' || !redirectUri.trim())
            throw new TypeError('A Strafe OAuth redirect URI is required');
        if (typeof fetchImpl !== 'function')
            throw new TypeError('A Fetch API implementation is required');

        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.redirectUri = redirectUri;
        this.authorizeUrl = new URL(authorizeUrl);
        this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
        this.fetch = fetchImpl;
    }

    generateState() {
        return randomBytes(32).toString('base64url');
    }

    getAuthorizationUrl({ scope = ['identify'], state } = {}) {
        if (typeof state !== 'string' || !state)
            throw new TypeError('A per-request OAuth state value is required');

        const requestedScopes = Array.isArray(scope) ? scope : String(scope).split(/\s+/);
        if (requestedScopes.length === 0 || requestedScopes.some((value) => typeof value !== 'string' || !value.trim()))
            throw new TypeError('At least one valid OAuth scope is required');
        const scopes = requestedScopes.map((value) => value.trim());

        const url = new URL(this.authorizeUrl);
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            scope: scopes.join(' '),
            state,
        }).toString();
        return url.toString();
    }

    exchangeCode(code, { signal } = {}) {
        if (typeof code !== 'string' || !code)
            throw new TypeError('An OAuth authorization code is required');
        return this.#tokenRequest({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.redirectUri,
        }, { signal });
    }

    refreshToken(refreshToken, { signal } = {}) {
        if (typeof refreshToken !== 'string' || !refreshToken)
            throw new TypeError('An OAuth refresh token is required');
        return this.#tokenRequest({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }, { signal });
    }

    async revokeToken(token, { signal } = {}) {
        if (typeof token !== 'string' || !token)
            throw new TypeError('An OAuth token is required');

        return this.#request('/oauth2/token/revoke', {
            token,
        }, { signal });
    }

    getUser(accessToken, { signal } = {}) {
        return this.#authorizedRequest('/users/@me', accessToken, { signal });
    }

    getTokenInfo(accessToken, { signal } = {}) {
        return this.#authorizedRequest('/oauth2/@me', accessToken, { signal });
    }

    getUserSpaces(accessToken, { signal } = {}) {
        return this.#authorizedRequest('/users/@me/spaces', accessToken, { signal });
    }

    #tokenRequest(body, { signal } = {}) {
        return this.#request('/oauth2/token', body, { signal });
    }

    async #request(path, body, { signal } = {}) {
        const url = new URL(path.replace(/^\/+/, ''), `${this.apiBaseUrl}/`);
        const response = await this.fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: new URLSearchParams(body),
            signal,
        });
        return this.#readResponse(response);
    }

    async #authorizedRequest(path, accessToken, { signal } = {}) {
        if (typeof accessToken !== 'string' || !accessToken)
            throw new TypeError('An OAuth access token is required');

        const url = new URL(path.replace(/^\/+/, ''), `${this.apiBaseUrl}/`);
        const response = await this.fetch(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
            },
            signal,
        });
        return this.#readResponse(response);
    }

    async #readResponse(response) {
        const text = await response.text();
        const body = parseResponseBody(text, response.headers.get('content-type') ?? '');
        if (response.ok)
            return body;

        const message = body?.error_description ?? body?.message ?? body?.error
            ?? `Strafe OAuth request failed with status ${response.status}`;
        throw new StrafeOAuthError(message, {
            status: response.status,
            body,
        });
    }
}
