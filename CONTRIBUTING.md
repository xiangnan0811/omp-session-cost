# Contributing

Contributions are welcome.

1. Fork the repository and create a focused branch.
2. Keep the extension dependency-light and avoid eager imports of OMP internal runtime packages.
3. Run `npm run check` before opening a pull request.
4. Describe the OMP version, operating system, and a minimal reproduction for bug fixes.

For changes to session parsing or pricing, please include a redacted JSONL shape or a small synthetic fixture when possible. Never commit real session transcripts because they can contain prompts, tool outputs, paths, and other private data.
