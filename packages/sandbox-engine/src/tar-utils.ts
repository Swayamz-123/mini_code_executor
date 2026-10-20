import tar from 'tar-stream';

export interface FileEntry {
  name: string;
  content: string | Buffer;
  mode?: number;
}

/**
 * Creates a tar archive in memory containing the specified files.
 */
export async function createTarArchive(files: FileEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    pack.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', (err: any) => reject(err));

    for (const file of files) {
      const buffer = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
      pack.entry(
        {
          name: file.name,
          size: buffer.length,
          mode: file.mode || 0o644,
          uid: 10001,
          gid: 10001,
        },
        buffer
      );
    }

    pack.finalize();
  });
}

/**
 * Extracts a specific file from a tar stream buffer.
 */
export async function extractFileFromTar(tarBuffer: Buffer, targetFileName: string): Promise<Buffer | null> {
  const extract = tar.extract();
  let foundBuffer: Buffer | null = null;

  return new Promise((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      if (header.name === targetFileName || header.name.endsWith(`/${targetFileName}`)) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('end', () => {
          foundBuffer = Buffer.concat(chunks);
          next();
        });
        stream.on('error', (err: any) => reject(err));
      } else {
        stream.resume();
        next();
      }
    });

    extract.on('finish', () => resolve(foundBuffer));
    extract.on('error', (err: any) => reject(err));

    extract.end(tarBuffer);
  });
}
