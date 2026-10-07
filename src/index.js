import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
const DEFAULT_API_URL = 'https://app.strafe.chat/api';
const DEFAULT_GATEWAY_URL = 'wss://app.strafe.chat/gateway/events';
export class StrafeApiError extends Error {
    constructor(message, { status, body, headers } = {}) {
        super(message);
        this.name = 'StrafeApiError';
        this.status = status;
        this.body = body;
        this.headers = headers;
    }
}
/**
 * @description delay function
 * @param {any} milliseconds
 * @returns {Promise<any>}
 */
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
/**
 * @description retryAfterMilliseconds function
 * @param {any} response
 * @param {any} body
 * @returns {number}
 */
function retryAfterMilliseconds(response, body) {
    const header = response.headers.get('retry-after');
    if (header !== null) {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0)
            return seconds * 1000;
        const date = Date.parse(header);
        if (Number.isFinite(date))
            return Math.max(0, date - Date.now());
    }
    const bodySeconds = Number(body?.retry_after);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0)
        return bodySeconds * 1000;
    return null;
}
/**
 * @description parseResponseBody function
 * @param {any} text
 * @param {any} contentType
 * @returns {any}
 */
function parseResponseBody(text, contentType) {
    if (!text)
        return null;
    if (contentType.includes('json')) {
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    return text;
}
export class StrafeClient extends EventEmitter {
    constructor({ token, authScheme = 'Bot', apiBaseUrl = DEFAULT_API_URL, gatewayUrl = DEFAULT_GATEWAY_URL, fetchImpl = globalThis.fetch, maxRetries = 5, retryBaseMs = 500, maxRetryDelayMs = 30000, autoReconnect = true, } = {}) {
        super();
        if (!token)
            throw new TypeError('A Strafe token is required');
        if (typeof fetchImpl !== 'function')
            throw new TypeError('A Fetch API implementation is required');
        this.token = token;
        this.authScheme = authScheme;
        this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
        this.gatewayUrl = gatewayUrl;
        this.fetch = fetchImpl;
        this.maxRetries = maxRetries;
        this.retryBaseMs = retryBaseMs;
        this.maxRetryDelayMs = maxRetryDelayMs;
        this.autoReconnect = autoReconnect;
        this.rateLimitUntil = 0;
        this.gateway = null;
        this.gatewayRetryTimer = null;
        this.gatewayRetryAttempt = 0;
        this.gatewayStopped = true;
        this.gatewayRevoked = false;
        this.gatewaySendQueue = Promise.resolve();
        this.gatewayTokens = 20;
        this.gatewayTokenUpdatedAt = Date.now();
    }
    async request(path, { method = 'GET', headers = {}, body, signal } = {}) {
        const url = new URL(String(path).replace(/^\/+/, ''), `${this.apiBaseUrl}/`);
        const requestMethod = method.toUpperCase();
        const canRetryServerErrors = ['GET', 'HEAD', 'OPTIONS', 'PATCH', 'PUT', 'DELETE'].includes(requestMethod);
        for (let attempt = 0;; attempt += 1) {
            const waitMs = this.rateLimitUntil - Date.now();
            if (waitMs > 0)
                await delay(waitMs);
            const requestHeaders = new Headers(headers);
            requestHeaders.set('Authorization', `${this.authScheme} ${this.token}`);
            let requestBody = body;
            if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof FormData)) {
                requestHeaders.set('Content-Type', 'application/json');
                requestBody = JSON.stringify(body);
            }
            const response = await this.fetch(url, {
                method: requestMethod,
                headers: requestHeaders,
                body: requestBody,
                signal,
            });
            const text = await response.text();
            const responseBody = parseResponseBody(text, response.headers.get('content-type') ?? '');
            if (response.ok)
                return responseBody;
            const retryAfterMs = retryAfterMilliseconds(response, responseBody);
            const retryable = response.status === 429 || (response.status >= 500 && canRetryServerErrors);
            if (response.status === 429) {
                const fallbackMs = Math.min(this.retryBaseMs * (2 ** attempt), this.maxRetryDelayMs);
                const backoffMs = retryAfterMs ?? fallbackMs;
                this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + backoffMs);
            }
            if (retryable && attempt < this.maxRetries) {
                if (response.status !== 429) {
                    const fallbackMs = Math.min(this.retryBaseMs * (2 ** attempt), this.maxRetryDelayMs);
                    await delay(retryAfterMs ?? fallbackMs);
                }
                continue;
            }
            const message = responseBody?.error ?? `Strafe API request failed with status ${response.status}`;
            throw new StrafeApiError(message, {
                status: response.status,
                body: responseBody,
                headers: response.headers,
            });
        }
    }
    /*
       * Fetches the authenticated user's information.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to the user object.
       * @throws StrafeApiError if the request fails.
       */
    getMe(options) {
        return this.request('/users/@me', options);
    }
    /*
     * Updates the user's presence status.
     * @param {*} options - An object containing the presence options.
     * @param {string} [options.status] - The new presence status (e.g., 'online', 'offline', 'idle', 'dnd').
     * @param {string} [options.custom_status] - A custom status message.
     * @returns Promise resolving to the updated user object.
     * @throws StrafeApiError if the request fails.
     */
    updatePresence(options) {
        let status = options.status;
        let custom_status = options.custom_status;
        return this.request('/users/@me', {
            method: 'PATCH',
            body: { presence: { status: status || null, custom_status: custom_status || null } }
        });
    }
    /*
       * Fetches the list of spaces the authenticated user is a member of.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to an array of space objects.
       * @throws StrafeApiError if the request fails.
       */
    getSpaces(options) {
        return this.request('/spaces', options);
    }
    /*
       * Fetches the details of a specific space by its ID.
       * @param {string} roomId - The ID of the space to fetch.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to the space object.
       * @throws StrafeApiError if the request fails.
       */
    getRoom(roomId, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}`, options);
    }
    /*
       * Fetches the list of messages in a specific space.
       * @param {string} roomId - The ID of the space to fetch messages from.
       * @param {Object} [options] - An object containing request options.
       * @returns Promise resolving to an array of message objects.
       * @throws StrafeApiError if the request fails.
       */
    getMessages(roomId, { limit, before, ...options } = {}) {
        const query = new URLSearchParams();
        if (limit !== undefined)
            query.set('limit', String(limit));
        if (before !== undefined)
            query.set('before', String(before));
        const suffix = query.size ? `?${query}` : '';
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages${suffix}`, options);
    }
    /*
        * Sends a message to a specific space.
        * @param {string} roomId - The ID of the space to send the message to.
        * @param {Object} message - The message object containing the content to send.
        * @param {*} options - An object containing request options.
        * @returns Promise resolving to the sent message object.
        * @throws StrafeApiError if the request fails.
        */
    sendMessage(roomId, message, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages`, {
            ...options,
            method: 'POST',
            body: message,
        });
    }
    /*
       * Edits a message in a specific space.
       * @param {string} roomId - The ID of the space containing the message to edit.
       * @param {string} messageId - The ID of the message to edit.
       * @param {Object} content - The new content for the message.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to the edited message object.
       * @throws StrafeApiError if the request fails.
       */
    editMessage(roomId, messageId, content, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, { ...options, method: 'PATCH', body: content });
    }
    /*
       * Deletes a message in a specific space.
       * @param {string} roomId - The ID of the space containing the message to delete.
       * @param {string} messageId - The ID of the message to delete.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to the deleted message object.
       * @throws StrafeApiError if the request fails.
       */
    deleteMessage(roomId, messageId, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, { ...options, method: 'DELETE' });
    }
    /*
       * Adds a reaction to a message in a specific space.
       * @param {string} roomId - The ID of the space containing the message to react to.
       * @param {string} messageId - The ID of the message to react to.
       * @param {string} emoji - The emoji to use for the reaction.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to the message object with the added reaction.
       * @throws StrafeApiError if the request fails.
       */
    addReaction(roomId, messageId, emoji, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`, { ...options, method: 'PUT' });
    }
    connectGateway() {
        if (this.gateway && this.gateway.readyState !== WebSocket.CLOSED)
            return this.gateway;
        this.gatewayStopped = false;
        this.gatewayRevoked = false;
        this.#openGateway();
        return this.gateway;
    }
    disconnectGateway(code = 1000, reason = 'Client disconnected') {
        this.gatewayStopped = true;
        clearTimeout(this.gatewayRetryTimer);
        this.gatewayRetryTimer = null;
        this.gateway?.close(code, reason);
    }
    subscribe(id) {
        return this.#sendGatewayFrame({ op: 1, d: { space_id: String(id) } });
    }
    unsubscribe(id) {
        return this.#sendGatewayFrame({ op: 5, d: { space_id: String(id) } });
    }
    /*
       * Sends a typing indicator to a specific space.
       * @param {string} roomId - The ID of the space where the typing indicator should be sent.
       * @returns Promise resolving when the typing indicator has been sent.
       * @throws Error if the Strafe gateway is not connected.
       */
    sendTyping(roomId) {
        return this.#sendGatewayFrame({
            op: 2,
            d: { space_id: String(roomId), type: 'typing' },
        });
    }
    #openGateway() {
        const socket = new WebSocket(this.gatewayUrl, {
            headers: { Authorization: `Bot ${this.token}` },
        });
        this.gateway = socket;
        socket.on('open', () => this.emit('gatewayOpen'));
        socket.on('message', (raw) => this.#handleGatewayMessage(raw));
        socket.on('error', (error) => this.emit('gatewayError', error));
        socket.on('close', (code, reason) => {
            this.emit('gatewayClose', code, reason.toString());
            if (this.gateway === socket)
                this.gateway = null;
            if (!this.gatewayStopped && !this.gatewayRevoked && this.autoReconnect) {
                this.#scheduleGatewayReconnect();
            }
        });
    }
    #handleGatewayMessage(raw) {
        let frame;
        try {
            frame = JSON.parse(raw.toString());
        }
        catch (error) {
            this.emit('gatewayError', error);
            return;
        }
        if (frame.op === 4) {
            this.gatewayRetryAttempt = 0;
            this.emit('ready', frame.d);
            return;
        }
        if (frame.op === 3) {
            const envelope = frame.d;
            this.emit('event', envelope);
            this.emit(envelope.t, envelope.d, envelope);
            if (envelope.t === 'SESSION_REVOKED') {
                this.gatewayRevoked = true;
                this.gatewayStopped = true;
                this.gateway?.close(1000, 'Session revoked');
            }
            return;
        }
        if (frame.op === 8) {
            const error = new Error(frame.d?.message ?? 'Strafe gateway error');
            error.code = frame.d?.code;
            this.emit('gatewayError', error);
        }
    }
    #scheduleGatewayReconnect() {
        const exponentialDelay = Math.min(1000 * (2 ** this.gatewayRetryAttempt), 30000);
        const jitteredDelay = exponentialDelay * (0.8 + Math.random() * 0.4);
        this.gatewayRetryAttempt += 1;
        this.gatewayRetryTimer = setTimeout(() => this.#openGateway(), jitteredDelay);
        this.gatewayRetryTimer.unref?.();
    }
    #sendGatewayFrame(frame) {
        if (!this.gateway || this.gateway.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Strafe gateway is not connected'));
        }
        /**
         * @description send function
         * @returns {Promise<void>}
         */
        const send = async () => {
            if (frame.op === 2)
                await this.#takeGatewayToken();
            if (!this.gateway || this.gateway.readyState !== WebSocket.OPEN) {
                throw new Error('Strafe gateway is not connected');
            }
            this.gateway.send(JSON.stringify(frame));
        };
        const result = this.gatewaySendQueue.then(send);
        this.gatewaySendQueue = result.catch(() => { });
        return result;
    }
    async #takeGatewayToken() {
        while (true) {
            const now = Date.now();
            const elapsed = now - this.gatewayTokenUpdatedAt;
            this.gatewayTokens = Math.min(20, this.gatewayTokens + elapsed / 250);
            this.gatewayTokenUpdatedAt = now;
            if (this.gatewayTokens >= 1) {
                this.gatewayTokens -= 1;
                return;
            }
            await delay((1 - this.gatewayTokens) * 250);
        }
    }
}
