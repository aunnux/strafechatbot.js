# StrafeChatBot.js

Node.js REST and WebSocket client for Strafe. Requires Node.js 18 or newer.

```sh
npm install
```

Keep bot tokens in environment variables; do not commit them.

```js
import { StrafeClient } from 'strafechatbot.js';

const client = new StrafeClient({ token: 'StrafeBotToken' });

client.on('ready', (ready) => {
  console.log(`Connected as ${ready.user.username}`);
});

client.on('MESSAGE_CREATE', async (message) => {
  if (message.plaintext === '!ping') {
    await client.sendMessage(message.room_id, {
      plaintext: 'pong',
      reply_to_id: message.id,
    });
  }
});

client.on('gatewayError', (error) => console.error(error));
client.connectGateway();
```

The defaults target `https://app.strafe.chat/api` and
`wss://app.strafe.chat/gateway/events`. Pass `apiBaseUrl` and `gatewayUrl` to
connect to another Strafe instance. REST authentication defaults to
`Authorization: Bot <token>`; set `authScheme: 'Bearer'` for a scoped OAuth
access token. The gateway requires a bot token.

## REST

Use `request(path, options)` for any API endpoint. Convenience methods include
`getMe`, `getSpaces`, `getRoom`, `getMessages`, `sendMessage`, `editMessage`,
`deleteMessage`,`updatePresence`, and `addReaction`.

```js
client.on('gatewayClose', (code, reason) => console.log(code, reason));
client.connectGateway();
// Later:
client.disconnectGateway();
```

See the [Strafe developer docs](https://app.strafe.chat/docs/), especially the
[REST API](https://app.strafe.chat/docs/rest/),
[Gateway](https://app.strafe.chat/docs/gateway/), and
[Bots](https://app.strafe.chat/docs/bots/) references.