import type buffer from 'buffer';
import path from 'path';
import crypto from 'crypto';
import chokidar from 'chokidar';
import fs, { ReadStream, WriteStream } from 'fs-extra';
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

const globalCacheDirSet = new Set<string>();

export class SafeFileCache {
  readonly options: Required<SafeFileCacheOptions>;

  constructor(options?: SafeFileCacheOptions) {
    const { cacheDir: _cacheDir } = options || {};
    const cacheDir = path.resolve(_cacheDir || '.fileCache');

    this.options = {
      hashAlgorithm: 'sha1',
      fastHash: false,
      hashSalt: process.env.NODE_ENV || '',
      lockTimeout: 5 * 60000,
      ...options,
      cacheDir,
    };

    if (globalCacheDirSet.has(cacheDir)) {
      throw new Error(`Duplicate cache directory: ${cacheDir}`);
    }
    globalCacheDirSet.add(cacheDir);
  }

  /**
   * 保存缓存文件
   * @param filename
   * @param file
   * @param opts
   */
  async save(
    filename: string,
    file: ReadStream | buffer.Buffer,
    opts?: SaveFileOptions
  ): Promise<string> {
    const { hashAlgorithm, fastHash, lockTimeout } = this.options;
    const { timeout = 0 } = opts || {};
    const { cachePath, integrityPath, lockPath } = this._getCachePaths(filename);
    let hasLock = false;

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
        hasLock = true;
      }

      let fileHash: string;

      if (file instanceof ReadStream) {
        await new Promise((resolve, reject) => {
          let cacheFileStream: WriteStream;
          const hash = crypto.createHash(hashAlgorithm);

          const handleWriteFile = () => {
            file
              .on('data', (chunk) => {
                cacheFileStream.write(chunk);
                if (!fastHash) {
                  hash.write(chunk);
                }
              })
              .on('end', () => {
                cacheFileStream.close();

                resolve(
                  (async () => {
                    if (fastHash) {
                      fileHash = await this._computeFileMtimeHash(cachePath);
                    } else {
                      fileHash = hash.digest('hex');
                    }
                  })()
                );
              })
              .on('error', reject);
          };

          cacheFileStream = fs
            .createWriteStream(cachePath, { flags: 'wx' })
            .on('open', handleWriteFile)
            .on('error', (err) => reject(err));
        });
      } else {
        await fs.writeFile(cachePath, file, { flag: 'wx' });
        if (fastHash) {
          fileHash = await this._computeFileMtimeHash(cachePath);
        } else {
          fileHash = crypto.createHash(hashAlgorithm).update(file).digest('hex');
        }
      }

      // 写入文件指纹 .integrity
      await fs.writeFile(integrityPath, fileHash!);

      return cachePath;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        if (await fs.pathExists(lockPath)) {
          // 等待释放锁文件
          await new Promise<void>((resolve, reject) => {
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
        }

        // 校验缓存文件完整性
        if (!(await this.load(filename))) {
          throw new Error(`Failed to save file: ${filename}`);
        }

        return cachePath;
      }

      throw err;
    } finally {
      if (hasLock) {
        await this._tryRemoveFile(lockPath);
      }
    }
  }

  /**
   * 加载缓存文件流
   * @param filename
   */
  async loadStream(filename: string): Promise<ReadStream | null> {
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
  async loadBuffer(filename: string): Promise<buffer.Buffer | null> {
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
    let actualHash = fastHash
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
   * 计算字符串文本 hash
   * @param text
   * @private
   */
  private _hashText(text: string): string {
    const { hashAlgorithm } = this.options;
    return crypto.createHash(hashAlgorithm).update(text).digest('hex');
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
    const lockPath = path.join(cacheDir, `${cacheName}.lock`);

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
  private async _computeFileContentHash(file: ReadStream): Promise<string> {
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
