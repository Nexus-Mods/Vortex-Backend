import { IAvailableExtension } from './types';

export function validateManifestEntry(entry: IAvailableExtension): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields exist and have correct types
  if (typeof entry.modId !== 'number') {
    errors.push('modId must be a number');
  }

  if (typeof entry.fileId !== 'number') {
    errors.push('fileId must be a number');
  }

  if (typeof entry.author !== 'string') {
    errors.push('author must be a string');
  }

  if (typeof entry.uploader !== 'string') {
    errors.push('uploader must be a string');
  }

  // Validate description object
  if (!entry.description || typeof entry.description !== 'object') {
    errors.push('description must be an object');
  } else {
    if (typeof entry.description.short !== 'string') {
      errors.push('description.short must be a string');
    }
    if (typeof entry.description.long !== 'string') {
      errors.push('description.long must be a string');
    }
  }

  if (typeof entry.downloads !== 'number') {
    errors.push('downloads must be a number');
  }

  if (typeof entry.endorsements !== 'number') {
    errors.push('endorsements must be a number');
  }

  if (entry.image !== undefined && typeof entry.image !== 'string') {
    errors.push('image must be a string or undefined');
  }

  if (typeof entry.name !== 'string') {
    errors.push('name must be a string');
  }

  if (typeof entry.timestamp !== 'number') {
    errors.push('timestamp must be a number');
  }

  if (!Array.isArray(entry.tags)) {
    errors.push('tags must be an array');
  }

  if (typeof entry.version !== 'string') {
    errors.push('version must be a string');
  }

  if (entry.type !== null && typeof entry.type !== 'string') {
    errors.push('type must be a string or null');
  }

  // gameName is optional but should be a string if present
  if (entry.gameName !== undefined && typeof entry.gameName !== 'string') {
    errors.push('gameName must be a string or undefined');
  }

  // Additional validation checks
  if (entry.type === 'game' && !entry.gameName) {
    errors.push('game extensions must have a gameName');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function getExpectedFieldOrder(): string[] {
  return [
    'modId',
    'fileId',
    'author',
    'uploader',
    'description',
    'downloads',
    'endorsements',
    'image',
    'name',
    'timestamp',
    'tags',
    'version',
    'type',
    'gameName',
  ];
}

export function normalizeManifestEntry(entry: IAvailableExtension): IAvailableExtension {
  const normalized: any = {};
  const fieldOrder = getExpectedFieldOrder();

  // Add fields in the correct order
  for (const field of fieldOrder) {
    if (entry[field as keyof IAvailableExtension] !== undefined) {
      normalized[field] = entry[field as keyof IAvailableExtension];
    }
  }

  return normalized as IAvailableExtension;
}
