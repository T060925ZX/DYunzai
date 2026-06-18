# Third-Party Runtime Notices

The Windows package can include the following redistributable runtimes:

- Node.js 24 LTS: https://nodejs.org/ (MIT and bundled third-party licenses)
- pnpm: https://pnpm.io/ (MIT)
- Git for Windows / MinGit: https://gitforwindows.org/ (GPL-2.0 and bundled licenses)
- FFmpeg Essentials build: https://www.gyan.dev/ffmpeg/builds/ (FFmpeg LGPL/GPL components)
- Redis for Windows: https://github.com/redis-windows/redis-windows

Each runtime directory retains the license and notice files shipped by its
upstream archive. Redis 8 is offered under Redis' published tri-license terms;
review those terms before redistributing the installer commercially.

## Bundled Fonts

- Noto Sans CJK Simplified Chinese: https://github.com/notofonts/noto-cjk
- Noto Color Emoji: https://github.com/googlefonts/noto-emoji

Both fonts are distributed under the SIL Open Font License 1.1. Their license
texts are included in `renderer/fonts`.
