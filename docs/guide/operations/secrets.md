# Secrets and the encryption key

SLM reads the credentials it needs at startup from `.env.secrets`, and the rest of its startup configuration from
`.env`.

## The secrets file

| variable                             | what it is                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `SETTINGS_ENCRYPTION_KEY`            | encrypts sensitive settings at rest (see [The encryption key](#the-encryption-key)) |
| `SETTINGS_ENCRYPTION_KEY_PREVIOUS`   | the key being rotated away from, set only while rotating                            |
| `DISCORD_CLIENT_SECRET`              | the Discord app's oauth2 client secret                                              |
| `DISCORD_BOT_TOKEN`                  | the Discord bot token                                                               |
| `BACKUP_SFTP_PASSWORD`               | if backups upload to an sftp host                                                   |
| `BACKUP_SFTP_PRIVATE_KEY_PASSPHRASE` | if that host authenticates with an encrypted key                                    |

The BattleMetrics, Squad Browser and Steam credentials are entered on the settings page instead. See
[Integrations](../configuring/integrations.md).

Keep `.env.secrets` out of version control, and out of any backup not secure enough to hold a password.

Mount the file into the container. Do not pass its values as environment variables. The installed
`docker-compose.yaml` already mounts it:

```yaml
services:
   app:
      volumes:
         - ./.env.secrets:/app/.env.secrets:ro
      env_file: .env
```

SLM reads `.env.secrets` as a file and never loads it into its environment, so the credentials do not show up in
`docker inspect` or in anything SLM starts. SLM warns on every start while one of these variables is set in the
environment.

### Moving credentials into the secrets file

An install that predates `.env.secrets` keeps working with its credentials in `.env`. To move them:

1. Take the variables listed above out of `.env`.
2. Put them in a `.env.secrets` next to it.
3. Add the mount above to the `app` service in `docker-compose.yaml`, then run `docker compose up -d`.

## Secrets managers

If a secrets manager delivers your credentials, point SLM at what it mounts. SLM reads two layouts:

- `SECRETS_FILE`: one file in the same `KEY=value` format as `.env.secrets`, wherever it is mounted.
- `SECRETS_DIR`: a directory holding one file per credential, named after the variable. Docker and podman secrets,
  a kubernetes secret volume and systemd's `LoadCredential=` all produce this layout. SLM reads only the variables
  listed above from it, and drops a trailing newline.

As docker secrets, one per credential:

```yaml
services:
   app:
      environment:
         - SECRETS_DIR=/run/secrets
      secrets:
         - SETTINGS_ENCRYPTION_KEY
         - DISCORD_CLIENT_SECRET
         - DISCORD_BOT_TOKEN

secrets:
   SETTINGS_ENCRYPTION_KEY:
      file: ./secrets/SETTINGS_ENCRYPTION_KEY
   DISCORD_CLIENT_SECRET:
      file: ./secrets/DISCORD_CLIENT_SECRET
   DISCORD_BOT_TOKEN:
      environment: DISCORD_BOT_TOKEN # taken from the environment `docker compose` runs in
```

A file in `SECRETS_DIR` wins over the same variable in `SECRETS_FILE`. If either points at something that does not
exist, SLM refuses to start.

On one host running Docker Compose, a docker secret sourced from a file is a bind mount of that file, stored on disk in
plaintext exactly as `.env.secrets` is. Docker secrets protect the values at rest only under Swarm, or when a secrets
manager delivers them.

## The encryption key

`SETTINGS_ENCRYPTION_KEY` encrypts each server's RCON and SFTP passwords, its server-agent token, and the integration
tokens entered on the settings page. SLM refuses to start without it, or with a key shorter than 16 characters.
`install.sh` generates one. To generate one by hand:

```sh
openssl rand -base64 32
```

Store a copy of the key with your backups. A backup restored without its key comes up with every server disabled and
every integration token unset (see [Restoring](backups.md#restoring)).

### Rotating the key

1. Move the current value to `SETTINGS_ENCRYPTION_KEY_PREVIOUS`.
2. Put the new key in `SETTINGS_ENCRYPTION_KEY`.
3. Start SLM. It re-encrypts everything under the new key, and logs each server it re-encrypted.
4. Remove `SETTINGS_ENCRYPTION_KEY_PREVIOUS`.

### Losing the key

SLM disables each server whose secrets it cannot decrypt. Re-enter the RCON and SFTP passwords, agent tokens and
integration tokens on the settings page to enable them again.
