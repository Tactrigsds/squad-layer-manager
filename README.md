# Squad Layer Manager

A Tool for managing the upcoming layers of a squad server, and other things also.

## Documentation

- [Installing](docs/INSTALLING.md) - Get SLM Running
- [Configuring](docs/CONFIGURING.md) - Configure SLM to work for your squad server
- [Layer data](docs/LAYER_DATA.md) - the layer artifact pair, how it is resolved, and building your own.
- [Contributing](CONTRIBUTING.md) - local dev setup, the test suites, and the pre-push hook.

## Deployment

Docker, via Docker Compose. The image (`ghcr.io/tactrigsds/squad-layer-manager:latest`, built from `main`) carries
the app and a complete set of layer data. See [docs/INSTALLING.md](docs/INSTALLING.md) for the full walkthrough; the
short version is:

```sh
mkdir squad-layer-manager && cd squad-layer-manager
curl -fsSL https://raw.githubusercontent.com/Tactrigsds/squad-layer-manager/main/install.sh | bash
```

Then create the Discord app, fill in `.env` and `.env.secrets` (which holds the credentials), and
`docker compose up -d`. Everything else is configured from the app's settings page.

## Pull Request Guidelines

All contributions must pass all tests and linting checks before being reviewed.

LLM co-authored code is acceptable, but it:

- Must resolve a previously agreed upon and known issue
- Must be disclosed as being LLM authored, and should include which models were used
- Should be a reasonable size
- Must be thoroughly tested, including e2e/integration tests where applicable
- Must have a human-authored PR description and comments

You as the contributor must take responsibility for the code you submit, and you need to be able to understand/read it in order to deal with feedback. If you are not a programmer yourself that's not fluent in typescript(or rust where applicable), then you shouldn't contribute.
