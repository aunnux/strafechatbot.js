# StrafeChatBot.js

Node.js REST and WebSocket client for Strafe. Requires Node.js 18 or newer.

```sh
npm install strafechatbot.js
```

Keep bot tokens in environment variables; do not commit them.

```js
import { Client } from 'strafechatbot.js';

const client = new Client({ token: 'StrafeBotToken' });

client.on('ready', (ready) => {
  console.log(`Connected as ${ready.user.username}`);
});

client.on('messageCreate', async (message) => {
  if (message.plaintext === '!ping') {
    await message.send({
      plaintext: 'pong',
      reply_to_id: message.id,
    });
  }
});

client.on('gatewayError', (error) => console.error(error));
client.connectGateway();
```

Gateway event names are also emitted in camelCase (`MESSAGE_CREATE` and
`messageCreate` both work). Message events provide `Message` objects with
payload fields such as `id`, `plaintext`, `sender_id`, and `room_id`, as well
as `send()`, `edit()`, `delete()`, and `react()` methods. `message.room`
and `message.channel` refer to the cached room.

The client maintains `client.users`, `client.spaces`, `client.rooms`
(`client.channels` is an alias), and `client.members` collections. Spaces have
their own `space.rooms` / `space.channels` and `space.members` collections.
The global member cache uses `spaceId:userId` keys; use `space.members.get(userId)`
for a member in a particular space.
`client.getSpaces()`, `client.getRoom()`, `client.getSpaceRooms(spaceId)`,
`client.getMessages()`, and `client.getMembers(spaceId)` populate these
caches; member lists are not sent in the gateway `READY` payload. A space
also offers `space.fetchRooms()` and `space.fetchMembers()`.

The defaults target `https://app.strafe.chat/api` and
`wss://app.strafe.chat/gateway/events`. Pass `apiBaseUrl` and `gatewayUrl` to
connect to another Strafe instance. REST authentication defaults to
`Authorization: Bot <token>`; set `authScheme: 'Bearer'` for a scoped OAuth
access token. The gateway requires a bot token.

## REST

Use `request(path, options)` for any API endpoint. Convenience methods include
`getMe`, `getSpaces`, `getRoom`, `getMessages`, `send`, `editMessage`,
`deleteMessage`, `updatePresence`, and `addReaction`. You can also send to the
current room with `room.send(payload)` or `message.send(payload)`.
Message instances support `message.edit(payload)`, `message.delete()`, and
`message.react(emoji)`.

```js
client.on('gatewayClose', (code, reason) => console.log(code, reason));
client.connectGateway();
// Later:
client.disconnectGateway();
```

## Useful Functions/Tools
```js
import { Function, Collection } from 'strafechatbot.js';
// Delays for 13seconds
await Function.delay(13000);
const cmds = new Collection(); // Borrowed from D.js
```
See the [Strafe developer docs](https://app.strafe.chat/docs/), especially the
[REST API](https://app.strafe.chat/docs/rest/),
[Gateway](https://app.strafe.chat/docs/gateway/), and
[Bots](https://app.strafe.chat/docs/bots/) references.

## OAuth sign-in

Use `StrafeOAuth` from your **server-side** website code to let people sign in
or register with Strafe. OAuth applications are confidential: the client
secret is sent to Strafe when exchanging or refreshing tokens, so never expose
it in browser code. Register the exact callback URL with your Strafe
application. Generate and store a fresh `state` value in the visitor's session
for each login attempt, and verify the returned state before exchanging the
code.

```js
import { StrafeOAuth } from 'strafechatbot.js';

const oauth = new StrafeOAuth({
  clientId: process.env.STRAFE_CLIENT_ID,
  clientSecret: process.env.STRAFE_CLIENT_SECRET,
  redirectUri: 'https://example.com/auth/strafe/callback',
});

// At the start of sign-in, store this state in the visitor's server session.
const state = oauth.generateState();
session.strafeOAuthState = state;
const authorizationUrl = oauth.getAuthorizationUrl({
  scope: ['identify', 'email'],
  state,
});

// In your callback handler, compare the returned state to the stored value
// before using the code. Clear the stored state after checking it.
const tokens = await oauth.exchangeCode(request.query.code);
const user = await oauth.getUser(tokens.access_token);
```

`StrafeOAuth` also provides `refreshToken(refreshToken)`,
`revokeToken(token)`, `getTokenInfo(accessToken)`, and
`getUserSpaces(accessToken)`. Request only the scopes your site needs. Set
`authorizeUrl` and `apiBaseUrl` in the constructor when connecting to another
Strafe instance. See the [OAuth2 documentation](https://app.strafe.chat/docs/oauth2)
for supported scopes and token behavior.