import type stream from 'stream';

/**
 * 读取 stream 为字符串
 * @param stream
 */
export function readStreamToString(stream: stream.Transform): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    stream.on('data', (chunk) => {
      chunks.push(chunk.toString());
    });
    stream.on('end', () => {
      resolve(chunks.join(''));
    });
    stream.on('error', reject);
  });
}

// noop
export function noop() {}
