import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { delay, parseResponseBody, retryAfterMilliseconds } from '../util/functions.js';
import { Collection } from '../util/Collection.js';
import { Member, Message, Room, Space, User } from '../structures/Structures.js';
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
export class Client extends EventEmitter {
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
        this.users = new Collection();
        this.spaces = new Collection();
        this.rooms = new Collection();
        this.channels = this.rooms;
        this.members = new Collection();
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
        return this.request('/users/@me', options).then((data) => this.#cacheUser(data));
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
        return this.request('/spaces', options).then((data) => {
            if (!Array.isArray(data))
                return data;
            return data.map((space) => this.#cacheSpace(space));
        });
    }
    /*
       * Fetches the details of a specific space by its ID.
       * @param {string} roomId - The ID of the space to fetch.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to the space object.
       * @throws StrafeApiError if the request fails.
       */
    getRoom(roomId, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}`, options).then((data) => this.#cacheRoom(data));
    }
    getSpaceRooms(spaceId, options) {
        return this.request(`/spaces/${encodeURIComponent(spaceId)}/rooms`, options).then((data) => {
            if (!Array.isArray(data))
                return data;
            return data.map((room) => this.#cacheRoom({
                ...room,
                space_id: room.space_id ?? String(spaceId),
            }));
        });
    }
    getMembers(spaceId, options) {
        return this.request(`/spaces/${encodeURIComponent(spaceId)}/members`, options).then((data) => {
            if (!Array.isArray(data))
                return data;
            return new Collection(data.map((member) => {
                const cached = this.#cacheMember(spaceId, member);
                return [cached.id, cached];
            }));
        });
    }
    getMember(spaceId, userId, options) {
        return this.request(`/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`, options)
            .then((data) => this.#cacheMember(spaceId, data));
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
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages${suffix}`, options).then((data) => {
            if (!Array.isArray(data))
                return data;
            return data.map((message) => this.#cacheMessage({
                ...message,
                room_id: message.room_id ?? String(roomId),
            }));
        });
    }
    /*
        * Sends a message to a specific space.
        * @param {string} roomId - The ID of the space to send the message to.
        * @param {Object} message - The message object containing the content to send.
        * @param {*} options - An object containing request options.
        * @returns Promise resolving to the sent message object.
        * @throws StrafeApiError if the request fails.
        */
    send(roomId, message, options) {
        if (roomId instanceof Room || roomId instanceof Message)
            return roomId.send(message, options);
        if (typeof roomId === 'object' && roomId !== null && message === undefined) {
            const { room_id: inferredRoomId, ...content } = roomId;
            if (!inferredRoomId)
                throw new TypeError('A room ID is required to send a message');
            return this.send(inferredRoomId, content, options);
        }
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages`, {
            ...options,
            method: 'POST',
            body: message,
        }).then((data) => this.#cacheMessage({
            ...data,
            room_id: data?.room_id ?? String(roomId),
        }));
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
    edit(roomId, messageId, content, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, { ...options, method: 'PATCH', body: content })
            .then((data) => this.#cacheMessage({
                ...data,
                room_id: data?.room_id ?? String(roomId),
                id: data?.id ?? String(messageId),
            }));
    }
    /*
       * Deletes a message in a specific space.
       * @param {string} roomId - The ID of the space containing the message to delete.
       * @param {string} messageId - The ID of the message to delete.
       * @param {*} options - An object containing request options.
       * @returns Promise resolving to the deleted message object.
       * @throws StrafeApiError if the request fails.
       */
    delete(roomId, messageId, options) {
        return this.request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, { ...options, method: 'DELETE' })
            .then((data) => {
                this.rooms.get(String(roomId))?.messages.delete(String(messageId));
                return data;
            });
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
            this.#cacheReady(frame.d);
            this.emit('ready', frame.d);
            return;
        }
        if (frame.op === 3) {
            const envelope = frame.d;
            const data = this.#cacheGatewayEvent(envelope);
            this.emit('event', envelope);
            this.emit(envelope.t, data, envelope);
            const camelCaseName = envelope.t.toLowerCase().replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase());
            if (camelCaseName !== envelope.t)
                this.emit(camelCaseName, data, envelope);
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
    #cacheReady(data = {}) {
        if (data.user)
            this.#cacheUser(data.user);
        for (const room of data.rooms ?? [])
            this.#cacheRoom(room);
        for (const space of data.spaces ?? [])
            this.#cacheSpace(space);
        for (const [spaceId, rooms] of Object.entries(data.space_rooms ?? {})) {
            for (const room of rooms)
                this.#cacheRoom({ ...room, space_id: room.space_id ?? spaceId });
        }
        for (const relationship of data.relationships ?? []) {
            if (relationship.user)
                this.#cacheUser(relationship.user);
        }
    }
    #cacheUser(data = {}) {
        if (!data.id)
            return data;
        const id = String(data.id);
        const user = this.users.get(id);
        if (user)
            return user.update(data);
        const cached = new User(data, this);
        this.users.set(id, cached);
        return cached;
    }
    #cacheSpace(data = {}) {
        if (!data.id)
            return data;
        const id = String(data.id);
        let space = this.spaces.get(id);
        if (space)
            space.update(data);
        else {
            space = new Space(data, this);
            this.spaces.set(id, space);
            for (const room of this.rooms.values()) {
                if (String(room.space_id) === id)
                    space.rooms.set(String(room.id), room);
            }
        }
        if (Array.isArray(data.rooms)) {
            for (const room of data.rooms)
                this.#cacheRoom({ ...room, space_id: room.space_id ?? id });
        }
        return space;
    }
    #cacheRoom(data = {}) {
        if (!data.id)
            return data;
        const id = String(data.id);
        const roomData = { ...data, id };
        if (roomData.space_id)
            roomData.space_id = String(roomData.space_id);
        let room = this.rooms.get(id);
        if (roomData.space_id === undefined && room?.space_id)
            roomData.space_id = room.space_id;
        if (room) {
            if (room.space_id && room.space_id !== roomData.space_id)
                this.spaces.get(room.space_id)?.rooms.delete(id);
            room.update(roomData);
        }
        else {
            room = new Room(roomData, this);
            this.rooms.set(id, room);
        }
        if (roomData.space_id)
            this.spaces.get(roomData.space_id)?.rooms.set(id, room);
        return room;
    }
    #cacheMember(spaceId, data = {}) {
        const userData = data.user ?? data;
        const userId = String(data.user_id ?? userData.id ?? data.id ?? '');
        if (!userId)
            return data;
        const spaceKey = String(spaceId ?? data.space_id ?? '');
        if (!spaceKey)
            throw new TypeError('A space ID is required to cache a member');
        const space = this.spaces.get(spaceKey) ?? this.#cacheSpace({ id: spaceKey });
        const memberFields = new Set([
            'space_id', 'user_id', 'role_ids', 'joined_at', 'nick', 'space_avatar',
            'space_banner', 'space_about_me', 'space_bio', 'space_pronouns',
        ]);
        const profile = Object.fromEntries(
            Object.entries(userData).filter(([key]) => !memberFields.has(key)),
        );
        const user = this.#cacheUser({ ...profile, id: userId });
        const memberData = { ...userData, ...data, id: userId, user_id: userId, space_id: spaceKey, user };
        let member = space.members.get(userId);
        if (member)
            member.update(memberData);
        else {
            member = new Member(memberData, this, space);
            space.members.set(userId, member);
        }
        member.user = user;
        this.members.set(`${spaceKey}:${userId}`, member);
        return member;
    }
    #cacheMessage(data = {}) {
        if (!data?.id)
            return data;
        const roomId = String(data.room_id ?? '');
        const room = this.rooms.get(roomId) ?? (roomId ? this.#cacheRoom({ id: roomId, space_id: data.space_id }) : null);
        const id = String(data.id);
        let message = room?.messages.get(id);
        if (message)
            message.update(data);
        else {
            message = new Message(data, this);
            room?.messages.set(id, message);
        }
        return message;
    }
    #cacheGatewayEvent(envelope) {
        const data = envelope.d ?? {};
        const eventType = envelope.t;
        const roomId = data.room_id ?? envelope.room_id;
        const spaceId = data.space_id ?? envelope.space_id;
        if (eventType === 'SPACE_CREATE') {
            return this.#cacheSpace(data);
        }
        if (eventType === 'SPACE_UPDATE') {
            const id = data.id ?? spaceId;
            return this.#cacheSpace({ ...data, id });
        }
        if (eventType === 'SPACE_DELETE' || eventType === 'SPACE_LEAVE') {
            const id = String(data.space_id ?? spaceId ?? '');
            const space = this.spaces.get(id);
            for (const room of space?.rooms.values() ?? [])
                this.rooms.delete(String(room.id));
            for (const memberId of space?.members.keys() ?? [])
                this.members.delete(`${id}:${memberId}`);
            this.spaces.delete(id);
            return data;
        }
        if (eventType === 'SPACE_ROOM_CREATE' || eventType === 'SPACE_ROOM_UPDATE' ||
            eventType === 'ROOM_CREATE' || eventType === 'ROOM_UPDATE' ||
            eventType === 'THREAD_CREATE' || eventType === 'THREAD_UPDATE') {
            return this.#cacheRoom({ ...data, id: data.id ?? roomId, space_id: data.space_id ?? spaceId });
        }
        if (eventType === 'SPACE_ROOM_DELETE' || eventType === 'THREAD_DELETE' || eventType === 'ROOM_LEAVE') {
            const id = String(data.room_id ?? roomId ?? '');
            const room = this.rooms.get(id);
            this.spaces.get(String(data.space_id ?? spaceId ?? room?.space_id ?? ''))?.rooms.delete(id);
            this.rooms.delete(id);
            return data;
        }
        if (eventType === 'SPACE_MEMBER_ADD' || eventType === 'SPACE_MEMBER_UPDATE')
            return this.#cacheMember(spaceId, data);
        if (eventType === 'SPACE_MEMBER_REMOVE') {
            const member = this.spaces.get(String(spaceId ?? data.space_id ?? ''))?.members.get(String(data.user_id));
            this.spaces.get(String(spaceId ?? data.space_id ?? ''))?.members.delete(String(data.user_id));
            this.members.delete(`${spaceId ?? data.space_id}:${data.user_id}`);
            return member ?? data;
        }
        if (eventType === 'USER_UPDATE') {
            const user = this.#cacheUser({ ...data, id: data.user_id ?? data.id });
            return user;
        }
        if (eventType === 'PRESENCE_UPDATE') {
            const userId = data.user_id ?? envelope.user_id;
            const user = userId
                ? this.#cacheUser({ id: userId, presence: data.presence })
                : null;
            return user ?? data;
        }
        if (eventType === 'MESSAGE_CREATE' || eventType === 'MESSAGE_UPDATE') {
            return this.#cacheMessage({
                ...data,
                room_id: data.room_id ?? roomId,
                space_id: data.space_id ?? spaceId,
            });
        }
        if (eventType === 'MESSAGE_DELETE') {
            this.rooms.get(String(roomId ?? ''))?.messages.delete(String(data.message_id));
            return data;
        }
        return data;
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
