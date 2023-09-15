const fs = require('fs-extra');
const assert = require('assert');
const { SafeFileCache } = require('./lib');

(async () => {
  await fs.remove('.fileCache');
  const fileCache = new SafeFileCache();

  const savePromise = fileCache.save('foo.txt', Buffer.of(...Array(1000).fill(97)));
  process.nextTick(() => {
    fileCache.save('foo.txt', 'bar');
  });

  await savePromise;

  assert(
    (await fileCache.loadBuffer('foo.txt')).toString() === 'a'.repeat(1000),
    'Unexpected'
  );
  assert((await fileCache.loadBuffer('bar.txt')) === null, 'Unexpected');
})();
