import * as fs from 'fs-extra';
import * as path from 'path';
import { IExtensionManifest } from './types';

const REPO_ROOT_PATH: string = path.join(__dirname, '/../');
const MANIFEST_PATH: string = path.join(REPO_ROOT_PATH, 'out');
const MANIFEST_FILENAME = 'extensions-manifest.json';
const MANIFEST_ARCHIVE_PATH: string = path.join(REPO_ROOT_PATH, 'archive');

// Mod IDs to remove (rejected or needs manual review from AI)
const MOD_IDS_TO_REMOVE: number[] = [];

async function sanitizeManifest() {
  console.log('Starting manifest sanitization...\n');

  // Read current manifest
  const manifestPath = path.join(MANIFEST_PATH, MANIFEST_FILENAME);
  const manifest: IExtensionManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  console.log(`Current manifest info:`);
  console.log(`Last updated: ${new Date(manifest.last_updated).toString()}`);
  console.log(`Total extensions: ${manifest.extensions.length}\n`);

  // Find extensions to remove
  const extensionsToRemove = manifest.extensions.filter(ext =>
    ext.modId !== undefined && MOD_IDS_TO_REMOVE.includes(ext.modId)
  );

  console.log(`Extensions to remove (${extensionsToRemove.length}):`);
  extensionsToRemove.forEach(ext => {
    console.log(`  - Mod ID ${ext.modId}: ${ext.name}`);
  });

  // Remove extensions
  const newExtensions = manifest.extensions.filter(ext =>
    ext.modId === undefined || !MOD_IDS_TO_REMOVE.includes(ext.modId)
  );

  console.log(`\nExtensions after removal: ${newExtensions.length}`);
  console.log(`Removed: ${manifest.extensions.length - newExtensions.length} extensions\n`);

  // Update manifest
  manifest.extensions = newExtensions;
  manifest.last_updated = Date.now();

  // Create archive of old manifest
  await fs.mkdirp(MANIFEST_ARCHIVE_PATH);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
  const archivePath = path.join(MANIFEST_ARCHIVE_PATH, `${timestamp}_before-sanitize_${MANIFEST_FILENAME}`);

  const originalManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  await fs.writeFile(archivePath, JSON.stringify(originalManifest, null, 2), 'utf-8');
  console.log(`Original manifest archived to: ${archivePath}\n`);

  // Write sanitized manifest
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`✅ Sanitized manifest saved!`);
  console.log(`New total: ${manifest.extensions.length} extensions`);
}

sanitizeManifest().catch(err => {
  console.error('Sanitization failed:', err);
  process.exit(1);
});
