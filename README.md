# safe-file-cache

Safely generate and consume cache files, better for cluster deployment.

## Requirements

- `Node` >= 14.14

## Installation

```bash
# use npm
npm install -S safe-file-cache

# use yarn
yarn add safe-file-cache

# use pnpm
pnpm install safe-file-cache
```

## Usage

```js
const { SafeFileCache } = require('safe-file-cache');

const fileCache = new SafeFileCache({
  cacheDir: '.fileCache',
});

async function getFileBuffer(filename) {
  let buffer = await fileCache.loadBuffer(filename);
  if (!buffer) {
    const cachePath = await fileCache.save(filename, '123' /* some data... */);
    buffer = await fs.readFile(cachePath);
  }
  return buffer;
}

getFileBuffer('foo.txt');
```

## API

See [type-definitions](./lib/index.d.ts).
