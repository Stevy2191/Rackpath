# Screenshots

The screenshots in the root [README](../../README.md). They're taken by the
browser tests (`web/e2e`), so they always show the current app:

```bash
cd web && npm run build
SHOTS=/tmp/shots node e2e/run.mjs   # needs a release build of api-rs
```

| File | Taken by |
|---|---|
| `floor-plan.png` | `places.mjs`: a floor plan with a drawn room and a placed rack |
| `rack-elevation.png` | `places.mjs`: a rack's front elevation |
| `rack-patching.png` | `cabling.mjs`: the rack patching view and a trace |
| `port-trace.png` | `cabling.mjs`: a port and its traced chain |
| `prefix.png` | `ipam.mjs`: a prefix with its address map |
| `template-designer.png` | `library.mjs`: the template designer |
| `rack-power.png` | `library.mjs`: a rack's power summary |
| `move-preview.png` | `moves.mjs`: a move previewed before it happens |
