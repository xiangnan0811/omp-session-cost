# Contributing

Run the complete local validation before opening a change:

```bash
npm run check
npm pack --dry-run
```

The extension intentionally has no third-party runtime dependencies and must not import OMP runtime packages eagerly at module load time.
