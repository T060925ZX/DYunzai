# DYunzai

DYunzai (Yunzai Desktop) is an Electron desktop launcher for TRSS-Yunzai. It manages Yunzai as an independent
Node.js child process and provides native configuration and plugin management.

## Development

```powershell
cd desktop-client
npm install
npm run runtime:download
npm start
```

The client can automatically clone `https://git.trss.me/Yunzai` into a
user-selected directory. An existing Yunzai instance can also be selected from
the Settings page.

## Build

```powershell
npm run build:win
```

The installer is written to `desktop-client/dist`.

The packaged client includes Node.js, pnpm, MinGit, Redis and FFmpeg under
`runtime/win-x64`. Yunzai configuration is edited directly as validated YAML;
plugins can be installed from Git repositories without Guoba-Plugin.
