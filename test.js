const fs = require('fs-extra');
const assert = require('assert');
const { SafeFileCache } = require('./lib');

(async () => {
  await fs.remove('.fileCache');
  const fileCache = new SafeFileCache();

  fileCache.save('foo.txt', Buffer.of(...Array(1000).fill(97)));
  await fileCache.save('foo.txt', 'bar');

  assert(
    (await fileCache.loadBuffer('foo.txt')).toString() === 'a'.repeat(1000),
    'Unexpected'
  );
  assert((await fileCache.loadBuffer('bar.txt')) === null, 'Unexpected');
})();
