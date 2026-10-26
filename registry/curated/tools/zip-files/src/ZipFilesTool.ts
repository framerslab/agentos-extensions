// @ts-nocheck
/**
 * @fileoverview Zip Files tool — create zip archives from local file paths.
 *
 * Uses the `archiver` npm package for cross-platform zip creation. Auto-cleans
 * old zip files from the output directory on each invocation.
 *
 * @module agentos-ext-zip-files/ZipFilesTool
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ZipFilesInput, ZipFilesOutput } from './types.js';
import { MAX_TOTAL_SIZE, ZIP_OUTPUT_DIR, CLEANUP_AGE_MS } from './types.js';

/** ITool implementation for creating zip archives. */
export class ZipFilesTool {
  readonly id = 'zip_files';
  readonly name = 'zip_files';
  readonly displayName = 'Zip Files';
  readonly description = 'Create a zip archive from local files. Returns the path to the created zip.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to include' },
      outputName: { type: 'string', description: 'Name for the zip file (without extension)' },
    },
    required: ['files'],
  };

  /** Execute the zip creation. */
  async execute(input: ZipFilesInput): Promise<ZipFilesOutput> {
    if (!existsSync(ZIP_OUTPUT_DIR)) mkdirSync(ZIP_OUTPUT_DIR, { recursive: true });

    this.cleanupOldZips();

    for (const filePath of input.files) {
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
    }

    let totalSize = 0;
    for (const filePath of input.files) {
      const fileStat = await stat(filePath);
      totalSize += fileStat.size;
    }
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error(`Total file size (${(totalSize / 1024 / 1024).toFixed(1)}MB) exceeds maximum of ${MAX_TOTAL_SIZE / 1024 / 1024}MB`);
    }

    const { ZipArchive } = await import('archiver');

    const zipName = `${input.outputName ?? `wunderland-${Date.now()}`}.zip`;
    const zipPath = join(ZIP_OUTPUT_DIR, zipName);

    return new Promise<ZipFilesOutput>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = new ZipArchive({ zlib: { level: 6 } });

      output.on('close', () => {
        resolve({
          path: zipPath,
          name: zipName,
          size: archive.pointer(),
          fileCount: input.files.length,
        });
      });

      archive.on('error', reject);
      archive.pipe(output);

      for (const filePath of input.files) {
        archive.file(filePath, { name: basename(filePath) });
      }

      archive.finalize();
    });
  }

  /** Delete zip files older than CLEANUP_AGE_MS from the output directory. */
  private cleanupOldZips(): void {
    if (!existsSync(ZIP_OUTPUT_DIR)) return;
    const now = Date.now();
    for (const file of readdirSync(ZIP_OUTPUT_DIR)) {
      const fullPath = join(ZIP_OUTPUT_DIR, file);
      try {
        const fileStat = statSync(fullPath);
        if (now - fileStat.mtimeMs > CLEANUP_AGE_MS) {
          unlinkSync(fullPath);
        }
      } catch { /* skip files we can't stat */ }
    }
  }
}
