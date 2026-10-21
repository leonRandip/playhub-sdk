# Contributing

Thanks for helping. Issues and pull requests are welcome.

- `pnpm install`, then `pnpm typecheck && pnpm test` must pass. `pnpm format` before committing.
- Keep the hub game-agnostic: it never interprets a game's `settings` or a player's `profile`.
- A change to the wire protocol goes in `packages/protocol` first, with tests, and bumps
  `PROTOCOL_VERSION` if old clients would misread it.
- By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
