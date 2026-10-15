# StrafeChatBot.js

Node.js REST and WebSocket client for Strafe. Requires Node.js 18 or newer.

```sh
npm install strafechatbot.js
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