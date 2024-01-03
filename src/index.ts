import path from 'path';
import crypto from 'crypto';
import chokidar from 'chokidar';
import stream from 'stream';
import fs from 'fs-extra';
import { noop, readStreamToString } from './utils';

export interface SafeFileCacheOptions {
  /** 缓存目录，默认：.fileCache */
  cacheDir?: string;
  /** hash 算法，默认：sha1 */
  hashAlgorithm?: 'md4' | 'md5' | 'sha1' | 'sha256';
  /** 是否使用快速计算 hash（不计算文件内容，而是文件修改时间），默认：false */
  fastHash?: boolean;
  /** hash salt */
  hashSalt?: string;
  /** lock 锁文件设置超时时间，默认：5min */
  lockTimeout?: number;
}

export interface SaveFileOptions {
  /** 等待写入文件超时时间，默认：0，表示用不超时 */
  timeout?: number;
}

export type FileData = stream.Readable | Buffer | string;

export interface SaveFileTask<T> extends Promise<T> {
  readonly stream: () => Promise<stream.Readable>;
}

const _cacheDirs = new Set<string>();

export class SafeFileCache {
  readonly options: Required<SafeFileCacheOptions>;
  private readonly _lockFiles = new Set<string>();
  private readonly _lockFileExt = '.LOCK$$';

  constructor(options?: SafeFileCacheOptions) {
    const { cacheDir: _cacheDir } = options || {};
    const cacheDir = path.resolve(_cacheDir || '.fileCache');

    if (_cacheDirs.has(cacheDir)) {
      console.error(`[Warn] duplicate cache directory: ${cacheDir}`);
    }
    _cacheDirs.add(cacheDir);

    this.options = {
      hashAlgorithm: 'sha1',
      fastHash: false,
      hashSalt: '',
      lockTimeout: 5 * 60000,
      ...options,
      cacheDir,
    };

    this._init();
  }

  /**
   * 保存缓存文件
   * @param filename
   * @param file
   * @param opts
   */
  save(
    filename: string,
    file: FileData | (() => FileData) | (() => Promise<FileData>),
    opts?: SaveFileOptions
  ): SaveFileTask<string> {
    let _stream: stream.Readable;

    const readyPromise = this.prepareSave(filename, opts).then(async (result) => {
      const { processor } = result;

      if (processor) {
        let fileData: FileData;
        try {
          fileData = typeof file === 'function' ? await file() : file;
        } catch (err) {
          processor.emit('error', err);
          throw err;
        }
        if (fileData instanceof stream.Readable) {
          _stream = fileData.pipe(processor);
        } else {
          await new Promise<void>((resolve, reject) => {
            processor.write(fileData, (error) => {
              if (error) reject(error);
              processor.end(resolve);
            });
          });
        }
      }

      return result;
    });

    const finalPromise = readyPromise.then(({ promise }) => promise);

    Object.defineProperty(finalPromise, 'stream', {
      value: async (): Promise<stream.Readable> => {
        const { promise } = await readyPromise;
        if (_stream) {
          return _stream;
        }

        const cachePath = await promise;
        return fs.createReadStream(cachePath);
      },
      writable: false,
      configurable: false,
      enumerable: false,
    });

    return finalPromise as SaveFileTask<string>;
  }

  /**
   * 准备处理 save
   * @param filename
   * @param opts
   */
  async prepareSave(
    filename: string,
    opts?: SaveFileOptions
  ): Promise<{ promise: Promise<string>; processor?: stream.Transform }> {
    const { hashAlgorithm, fastHash, lockTimeout } = this.options;
    const { timeout = 0 } = opts || {};
    const { cachePath, integrityPath, lockPath } = this._getCachePaths(filename);
    let hasLock = false;

    let cacheFileStream: stream.Writable | undefined;
    const hash = crypto.createHash(hashAlgorithm);

    const _tryRemoveLockFile = async () => {
      if (hasLock) {
        await this._tryRemoveFile(lockPath);
        this._lockFiles.delete(lockPath);
        hasLock = false;
      }
    };

    const processor = new stream.Transform({
      transform: (chunk, encoding, callback) => {
        if (cacheFileStream) {
          cacheFileStream.write(chunk);
        }
        if (!fastHash) {
          hash.write(chunk);
        }
        callback(null, chunk);
      },
      flush: async (callback) => {
        let error: any = undefined;
        try {
          const fileHash = fastHash
            ? await this._computeFileMtimeHash(cachePath)
            : hash.digest('hex');

          // 写入文件指纹 .integrity
          await fs.writeFile(integrityPath, fileHash);
        } catch (err: any) {
          error = err;
        } finally {
          await _tryRemoveLockFile();
          callback(error);
        }
      },
    });

    let promise = new Promise<string>((resolve, reject) => {
      processor
        .on('finish', () => resolve(cachePath))
        .on('error', (err) => {
          _tryRemoveLockFile();
          reject(err);
        });
    });

    try {
      await fs.ensureDir(path.dirname(cachePath));

      if (
        lockTimeout > 0 &&
        (await fs.pathExists(lockPath)) &&
        Date.now() - (await fs.stat(lockPath)).mtime.getTime() > lockTimeout
      ) {
        await this._tryRemoveFile(lockPath);
      }

      // 写入 .lock 文件
      if (!(await fs.pathExists(cachePath))) {
        await fs.writeFile(lockPath, '', { flag: 'wx' });
        this._lockFiles.add(lockPath);
        hasLock = true;
      }

      cacheFileStream = await new Promise<stream.Writable>((resolve, reject) => {
        const _cacheFileStream = fs
          .createWriteStream(cachePath, { flags: 'wx' })
          .on('open', () => resolve(_cacheFileStream))
          .on('error', (err) => reject(err));
      });

      return { promise, processor };
    } catch (err: any) {
      if (!(err?.code === 'EEXIST')) {
        throw err;
      }

      promise = fs
        .pathExists(lockPath)
        .then((exists) => {
          if (!exists) return;

          // 等待释放锁文件
          return new Promise<void>((resolve, reject) => {
            let timer: any;
            let watcher = chokidar.watch(lockPath);

            if (timeout > 0) {
              timer = setTimeout(() => {
                if (watcher) {
                  watcher.close();
                }
                reject(new Error(`Timeout in ${timeout}ms`));
              }, timeout);
            }

            watcher.on('unlink', () => {
              watcher.close();
              clearTimeout(timer);
              resolve();
            });
          });
        })
        .then(() => this.load(filename))
        .then((cachePath) => {
          if (!cachePath) {
            throw new Error(`Failed to process the file: ${filename}`);
          }
          return cachePath;
        });

      return { promise, processor: undefined };
    }
  }

  /**
   * 加载缓存文件流
   * @param filename
   */
  async loadStream(filename: string): Promise<stream.Readable | null> {
    const filePath = await this.load(filename);
    if (filePath) {
      return fs.createReadStream(filePath);
    }
    return null;
  }

  /**
   * 加载缓存文件 buffer
   * @param filename
   */
  async loadBuffer(filename: string): Promise<Buffer | null> {
    const filePath = await this.load(filename);
    if (filePath) {
      return fs.readFile(filePath);
    }
    return null;
  }

  /**
   * 加载缓存文件（校验完整性）
   * @param filename
   */
  async load(filename: string): Promise<string | null> {
    const { fastHash } = this.options;
    const { cachePath, integrityPath, lockPath } = this._getCachePaths(filename);

    if (await fs.pathExists(lockPath)) {
      return null;
    }

    if (!(await fs.pathExists(cachePath)) || !(await fs.pathExists(integrityPath))) {
      await this._tryRemoveFile(cachePath);
      await this._tryRemoveFile(integrityPath);
      return null;
    }

    // 校验文件完整性
    const actualHash = fastHash
      ? await this._computeFileMtimeHash(cachePath)
      : await this._computeFileContentHash(fs.createReadStream(cachePath));
    const expectHash = await fs.readFile(integrityPath, 'utf-8');
    if (actualHash !== expectHash) {
      await this._tryRemoveFile(cachePath);
      await this._tryRemoveFile(integrityPath);
      return null;
    }

    return cachePath;
  }

  /**
   * 实例初始化
   * @private
   */
  private _init() {
    const { cacheDir } = this.options;
    if (fs.pathExistsSync(cacheDir) && fs.statSync(cacheDir).isDirectory()) {
      const files = fs.readdirSync(cacheDir);
      for (const file of files) {
        if (file.endsWith(this._lockFileExt)) {
          fs.removeSync(path.join(cacheDir, file));
        }
      }
    }
  }

  /**
   * 计算字符串文本 hash
   * @param text
   * @private
   */
  private _hashText(text: string): string {
    const { hashAlgorithm, hashSalt } = this.options;
    const hash = crypto.createHash(hashAlgorithm);
    hash.update(hashSalt);
    hash.update('\n\n\n');
    hash.update(text);
    return hash.digest('hex');
  }

  /**
   * 返回缓存文件 paths
   * @param filename
   * @private
   */
  private _getCachePaths(filename: string) {
    const { cacheDir, fastHash } = this.options;

    const cacheName = this._hashText(filename) + path.extname(filename);
    const cachePath = path.join(cacheDir, cacheName);
    const integrityExt = `.${fastHash ? 'fast-' : ''}integrity`;
    const integrityPath = path.join(cacheDir, cacheName + integrityExt);
    const lockPath = path.join(cacheDir, cacheName + this._lockFileExt);

    return {
      cachePath,
      integrityPath,
      lockPath,
    };
  }

  /**
   * 计算文件内容 hash 值
   * @param file
   * @private
   */
  private async _computeFileContentHash(file: stream.Readable): Promise<string> {
    const { hashAlgorithm } = this.options;
    const fileHash = file.pipe(crypto.createHash(hashAlgorithm)).setEncoding('hex');
    return await readStreamToString(fileHash);
  }

  /**
   * 计算文件更新时间 hash 值
   * @param filePath
   * @private
   */
  private async _computeFileMtimeHash(filePath: string): Promise<string> {
    const { hashAlgorithm } = this.options;
    const { mtime } = await fs.stat(filePath);
    return crypto
      .createHash(hashAlgorithm)
      .update(mtime.getTime().toString())
      .digest('hex');
  }

  /**
   * 尝试移除文件
   * @param filePath
   * @private
   */
  private async _tryRemoveFile(filePath: string) {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath).catch(noop);
    }
  }
}
