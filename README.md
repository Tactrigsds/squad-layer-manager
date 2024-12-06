#  Squad Layer Manager

A Tool for managing the upcoming layers of a squad server.

## Configuration 
Configuration is done via two files: `.env` and `config.json`.
- `.env` contains sensitive secrets, and can be overridden by environment variables. Reference [src/server/env.ts](src/server/env.ts) for available options.
- `config.json` contains the configuration for the server. Reference [src/server/config.ts](src/server/config.ts) for available options.
`config.json` has a generated schema file at `src/assets/config-schema.json`. This file can be used to validate the configuration file in an editor like VSCode by including the property:
```json5
{
    "$schema": "src/assets/config-schema.json",
    // ... rest of configuration
}
```