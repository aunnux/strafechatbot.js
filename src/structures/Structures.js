import { Collection } from '../util/Collection.js';

export class User {
    constructor(data, client) {
        this.client = client;
        this.update(data);
    }

    update(data) {
        Object.assign(this, data);
        return this;
    }
}

export class Member {
    constructor(data, client, space) {
        this.client = client;
        this.space = space;
        this.user = null;
        this.update(data);
    }

    update(data) {
        const { id, ...properties } = data;
        Object.assign(this, properties);
        if (data.user)
            this.user = data.user;
        return this;
    }

    get id() {
        return this.user_id ?? this.user?.id;
    }
}

export class Space {
    constructor(data, client) {
        this.client = client;
        this.rooms = new Collection();
        this.channels = this.rooms;
        this.members = new Collection();
        this.update(data);
    }

    update(data) {
        const { rooms, ...properties } = data;
        Object.assign(this, properties);
        return this;
    }

    async fetchMembers(options) {
        return this.client.getMembers(this.id, options);
    }

    async fetchRooms(options) {
        return this.client.getSpaceRooms(this.id, options);
    }
}

export class Room {
    constructor(data, client) {
        this.client = client;
        this.messages = new Collection();
        this.update(data);
    }

    update(data) {
        const { messages, ...properties } = data;
        Object.assign(this, properties);
        return this;
    }

    get space() {
        return this.client.spaces.get(this.space_id);
    }

    sendMessage(message, options) {
        if (!this.id)
            throw new TypeError('A room ID is required to send a message');
        return this.client.sendMessage(this.id, message, options);
    }
}

export class Message {
    constructor(data, client) {
        this.client = client;
        this.update(data);
    }

    update(data) {
        Object.assign(this, data);
        return this;
    }

    get room() {
        return this.client.rooms.get(this.room_id);
    }

    get channel() {
        return this.room;
    }

    sendMessage(message, options) {
        if (!this.room_id)
            throw new TypeError('A room ID is required to send a message');
        return this.client.sendMessage(this.room_id, message, options);
    }

    edit(content, options) {
        if (!this.room_id || !this.id)
            throw new TypeError('A room ID and message ID are required to edit a message');
        return this.client.editMessage(this.room_id, this.id, content, options);
    }

    async delete(options) {
        if (!this.room_id || !this.id)
            throw new TypeError('A room ID and message ID are required to delete a message');
        await this.client.deleteMessage(this.room_id, this.id, options);
        return this;
    }

    react(emoji, options) {
        if (!this.room_id || !this.id)
            throw new TypeError('A room ID and message ID are required to react to a message');
        return this.client.addReaction(this.room_id, this.id, emoji, options);
    }
}
