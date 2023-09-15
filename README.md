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

### Basic

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

### Stream

```js
const { SafeFileCache } = require('safe-file-cache');
const express = require('express');
const axios = require('axios');

const app = express();

const fileCache = new SafeFileCache();

app.get('/foo', async (req, res) => {
  let stream = await fileCache.loadStream(filename);
  if (!stream) {
    stream = fileCache
      .save(filename, async () => {
        // fetch stream example
        const { data } = await axios.get('https://example.com/bar.tgz', {
          responseType: 'stream'
        });
        return data;
      })
      .stream();
  }
  stream.pipe(res);
});
```

## API

See [type-definitions](./src/index.ts).
