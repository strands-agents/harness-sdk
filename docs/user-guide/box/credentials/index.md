The agent needs keys to do its work, such as its model key or a token for GitHub. Box keeps those keys outside the box. A route, an `[egress.<name>]` table in a pack or your profile, names the hosts that get a key, and its `secret.ref` names where the key comes from. Inside the box, the agent gets a placeholder, and the box puts in the real key, or signs the request, as it leaves for one of the route’s hosts. [How Box works](/docs/user-guide/box/how-box-works/index.md#credentials) has the picture.

This page explains each place a key can come from, and how to point a route at it.

## Credential sources

A key can come from one of four places. The scheme at the start of `secret.ref` picks it:

|  | A variable in your shell | AWS credentials | The credentials daemon | A password manager or secret store |
| --- | --- | --- | --- | --- |
| `secret.ref` | `env://GH_TOKEN` | `aws://` or `aws://work` | `credsd://work` | `op://Personal/GitHub/token` |
| Read | Once, when the box starts | On each request | On each AWS request. For tokens, at startup and near expiry | Once, when the box starts |
| The agent gets | A placeholder in `GH_TOKEN` | Placeholder AWS keys | Placeholder AWS keys, or for a token, the placeholder that `secret.env` names | A placeholder in the variable `secret.env` names |
| Works for | Any HTTPS host | AWS service hosts | AWS service hosts, or any HTTPS host for a token | Any HTTPS host |
| Long-lived key kept in | Your shell | `~/.aws` | The daemon’s keystore | Your password manager |

A pack’s route already names a source, such as `aws://` for Bedrock. To use another one, set `secret.ref` on that route in your profile. `box profile show <name> --full` names the routes, and shows the `box.toml` with the source each one uses.

## A variable in your shell

An `env://` route reads a variable from the shell where you run `box run`:

```toml
[egress.github-api]
destinations = ["api.github.com"]
secret.ref = "env://GH_TOKEN"   # export GH_TOKEN before box run
```

Inside the box, `GH_TOKEN` holds a placeholder. The box swaps in the real token on each request to `api.github.com` that carries the placeholder. [Hosts and credentials](/docs/user-guide/box/profiles/index.md#hosts-and-credentials) shows more routes, such as one for `git push`.

## AWS credentials

An `aws://` route signs each request to an AWS host with SigV4, outside the box. Every program in the box gets placeholder `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values, so the AWS CLI and SDKs build their requests as usual, and the box signs them again with your real credentials.

```toml
[egress.bedrock.secret]
ref = "aws://work"   # the AWS profile `work`; `aws://` alone uses your default identity
```

`aws://<PROFILE>` signs as that AWS profile. `aws://` with no profile name signs with the first credentials that the AWS SDK finds outside the box, starting with the `AWS_*` variables in the shell where you run `box run`. So on a cloud machine, `aws://` can sign as the machine’s own role, and the box prints a warning about it. Box’s [credential sources](/docs/user-guide/box/guides/network-and-credentials/index.md#credential-sources) lists the profile forms and the full order.

Neither form signs with an AWS SSO or `aws login` profile. To sign in that way, keep the sign-in in [the credentials daemon](#the-credentials-daemon), or export its temporary keys ([AWS credentials resolve to nothing](/docs/user-guide/box/troubleshooting/index.md#aws-credentials-resolve-to-nothing)).

Both `aws://` forms run any `credential_process` in your AWS configuration outside the box. The box can’t write `~/.aws`, but if you move that configuration with `AWS_CONFIG_FILE` or `AWS_SHARED_CREDENTIALS_FILE`, keep the new place out of your project and every other folder the box can write.

## The credentials daemon

The [AWS Credential Daemon](https://github.com/aws/credential-daemon) (credsd) is a local service that holds your long-lived AWS sign-in, such as an IAM Identity Center (SSO) session or an IAM user’s keys, sealed in a hardware or OS keystore. It gives out short-lived session credentials over a local socket and refreshes them for you. A signed `credsd://` route asks it for credentials on each request, so an SSO sign-in works without exporting temporary keys, and the sign-in itself stays in the daemon.

`credsd://` names a credential you set up in the daemon. This profile signs Bedrock requests with the credential `work`:

```toml
[egress.bedrock.secret]
ref = "credsd://work"   # a credential that `creds bootstrap --credential work` created
type = "aws"
```

### Set up a credential

Install credsd and create the credential once, outside the box. [Getting started with credsd](https://github.com/aws/credential-daemon/blob/main/docs/getting-started.md) covers each platform. For an IAM Identity Center sign-in:

```sh
creds bootstrap --credential work aws-idc-sso \
  --start-url https://myorg.awsapps.com/start \
  --sso-region us-east-1
```

Box needs credsd 0.2.0 or later. A route signs with AWS credentials unless it says otherwise, so the credential must be one of the AWS types, such as `aws-idc-sso`, `aws-iam-user`, or `aws-login`. Set `secret.type = "aws"` on such a route: a route without the key still signs, and `box run` warns that a later release requires it.

### Use a token from credsd

A token credential, such as one from `creds bootstrap --credential github static-secret`, works like a key in your shell. Set `secret.type = "token"`, and the route takes the same keys as an `env://` route:

```toml
[egress.github]
destinations = ["github.com"]
secret.ref = "credsd://github"
secret.type = "token"
secret.placement = "basic_auth"   # the credsd secret holds x-access-token:<token>
secret.inject = "always"
```

The box reads a token at startup. If the daemon supplies an expiry, the first request near or past expiry asks the daemon again. The agent keeps the same placeholder. Without `secret.env`, the agent holds no placeholder, so the route needs `secret.inject = "always"`.

### What the box checks

Before the agent starts, the box asks the daemon whether it’s running, whether it lists each credential the profile names, and whether each one is the kind its route’s `secret.type` says. If a check fails, the run stops with a message that names the problem ([credsd errors](/docs/user-guide/box/troubleshooting/index.md#the-credentials-daemon-refuses-the-run)). A profile with no `credsd://` route never contacts the daemon.

After that, a signed route asks the daemon for the credential on each request and doesn’t cache it between requests, so a credential you sign in to again mid-run works on the next request. A `credsd://` route never falls back to your default AWS identity: when the daemon can’t give a credential, the request fails with a 403.

### Where the box finds the daemon

The box connects to the socket that credsd’s own install sets up. If your daemon listens somewhere else, set `CREDSD_SOCKET` to its full path in the shell where you run `box run`. [The credsd socket](/docs/user-guide/box/guides/network-and-credentials/index.md#the-credsd-socket) lists the default on each system.

On macOS, the box uses a socket in `~/Library/Application Support/credsd` whenever one is there, so keep that folder out of every folder the box can write. A profile that lets the agent write all of `~` or `~/Library` would let it put its own socket there, and a later run would ask that socket for its credentials.

## A password manager or secret store

A [plugin](/docs/user-guide/box/plugins/index.md) reads a key from a password manager or secret store, such as 1Password or AWS Secrets Manager, when the box starts. It runs the vault’s own program on your machine, outside the box, with your sign-in:

```toml
plugins = ["@box/1password"]

[egress.github]
destinations = ["api.github.com"]
secret.ref = "op://Personal/GitHub/token"
secret.env = "GH_TOKEN"   # the variable that holds the placeholder in the box
```

[Use a plugin](/docs/user-guide/box/plugins/index.md#use-a-plugin) shows how to list one and name the item.

## Rules for signed routes

An `aws://` or `credsd://` route signs each request for the AWS service and region its host names, such as `bedrock-runtime.us-west-2.amazonaws.com`. So its hosts must be AWS service hosts, and it can’t have `[[egress.<name>.backends]]`. It also takes none of the `secret` keys that place a token. Box’s [credential sources](/docs/user-guide/box/guides/network-and-credentials/index.md#credential-sources) has the full rules.