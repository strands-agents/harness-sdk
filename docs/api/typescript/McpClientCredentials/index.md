Defined in: [src/mcp/client.ts:57](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L57)

OAuth client credentials for machine-to-machine authentication.

## Properties

### clientId

```ts
clientId: string;
```

Defined in: [src/mcp/client.ts:58](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L58)

---

### clientSecret

```ts
clientSecret: string;
```

Defined in: [src/mcp/client.ts:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L59)

---

### scopes?

```ts
optional scopes?: string[];
```

Defined in: [src/mcp/client.ts:61](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L61)

OAuth scopes to request. Joined with spaces before sending to the token endpoint.