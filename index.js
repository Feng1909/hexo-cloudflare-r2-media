'use strict';

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { S3Client, DeleteObjectsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const mime = require('mime-types');

const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.avif',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.ogg',
  '.ogv'
]);

const ATTR_REGEX = /\b(?:src|href|poster|content)\s*=\s*(["'])([^"'#?]+(?:\.[A-Za-z0-9]+))\1/gi;
const SRCSET_REGEX = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;
const MANIFEST_FILE = '.r2-media-manifest.json';

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function trimSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '');
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function encodeUrlPath(value) {
  return value
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function isRemoteUrl(value) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('mailto:');
}

function hasMediaExtension(value) {
  const cleanPath = value.split(/[?#]/, 1)[0];
  return MEDIA_EXTENSIONS.has(path.extname(cleanPath).toLowerCase());
}

function resolvePublicPath(publicDir, htmlPath, assetUrl) {
  if (isRemoteUrl(assetUrl) || !hasMediaExtension(assetUrl)) {
    return null;
  }

  const htmlDir = path.dirname(htmlPath);
  const normalized = assetUrl.split(/[?#]/, 1)[0];
  if (normalized.startsWith('/img/')) {
    return null;
  }

  const assetPath = normalized.startsWith('/')
    ? path.join(publicDir, normalized.replace(/^\/+/, ''))
    : path.resolve(htmlDir, normalized);

  if (!assetPath.startsWith(publicDir)) {
    return null;
  }

  if (!assetPath.startsWith(`${htmlDir}${path.sep}`)) {
    return null;
  }

  return assetPath;
}

async function collectFiles(dir, extension) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath, extension);
    }

    if (!extension || fullPath.endsWith(extension)) {
      return [fullPath];
    }

    return [];
  }));

  return files.flat();
}

async function collectMediaFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectMediaFiles(fullPath);
    }

    if (MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      return [fullPath];
    }

    return [];
  }));

  return files.flat();
}

async function loadManifest(baseDir) {
  const manifestPath = path.join(baseDir, MANIFEST_FILE);
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed ? parsed : { version: 1, assets: {} };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { version: 1, assets: {} };
    }

    throw error;
  }
}

async function saveManifest(baseDir, manifest) {
  const manifestPath = path.join(baseDir, MANIFEST_FILE);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectSourcePostAssets(baseDir, keyPrefix) {
  const postsDir = path.join(baseDir, 'source', '_posts');
  if (!(await pathExists(postsDir))) {
    return [];
  }

  const entries = await fs.readdir(postsDir, { withFileTypes: true });
  const assets = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const assetDir = path.join(postsDir, entry.name);
    const mediaFiles = await collectMediaFiles(assetDir);
    for (const filePath of mediaFiles) {
      const publicRelativePath = toPosixPath(path.join(entry.name, path.basename(filePath)));
      const objectKey = keyPrefix ? `${keyPrefix}/${publicRelativePath}` : publicRelativePath;
      assets.push({
        filePath,
        publicRelativePath,
        objectKey
      });
    }
  }

  return assets;
}

function buildPublicUrl(baseUrl, key) {
  return `${ensureTrailingSlash(baseUrl)}${encodeUrlPath(key)}`;
}

function replaceSrcset(value, replaceAssetUrl) {
  return value
    .split(',')
    .map(item => {
      const trimmed = item.trim();
      if (!trimmed) {
        return trimmed;
      }

      const parts = trimmed.split(/\s+/);
      parts[0] = replaceAssetUrl(parts[0]);
      return parts.join(' ');
    })
    .join(', ');
}

async function removePublicPostAssets(baseDir, publicDir) {
  const postsDir = path.join(baseDir, 'source', '_posts');
  if (!(await pathExists(postsDir))) {
    return 0;
  }

  const entries = await fs.readdir(postsDir, { withFileTypes: true });
  let removedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const publicAssetDir = path.join(publicDir, entry.name);
    if (!(await pathExists(publicAssetDir))) {
      continue;
    }

    const mediaFiles = await collectMediaFiles(publicAssetDir);
    for (const mediaFile of mediaFiles) {
      await fs.unlink(mediaFile);
      removedCount += 1;
    }
  }

  return removedCount;
}

hexo.extend.deployer.register('r2-media', async function registerR2Media(args) {
  const config = this.config.r2_media || {};
  const enabled = args.enable ?? config.enable ?? true;

  if (!enabled) {
    this.log.info('R2 media deployer skipped: disabled.');
    return;
  }

  const publicDir = this.public_dir;
  const bucket = args.bucket || config.bucket || process.env.R2_BUCKET;
  const endpoint = args.endpoint || config.endpoint || process.env.R2_ENDPOINT;
  const publicBaseUrl = args.public_base_url || config.public_base_url || process.env.R2_PUBLIC_BASE_URL;
  const accessKeyId = args.access_key_id || config.access_key_id || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = args.secret_access_key || config.secret_access_key || process.env.R2_SECRET_ACCESS_KEY;
  const keyPrefix = trimSlashes(args.key_prefix || config.key_prefix || process.env.R2_KEY_PREFIX || 'blog');
  const deleteStale = args.delete_stale ?? config.delete_stale ?? true;

  const missing = [];
  if (!bucket) missing.push('bucket');
  if (!endpoint) missing.push('endpoint');
  if (!publicBaseUrl) missing.push('public_base_url');
  if (!accessKeyId) missing.push('access_key_id');
  if (!secretAccessKey) missing.push('secret_access_key');

  if (missing.length) {
    throw new Error(`Missing r2_media config: ${missing.join(', ')}`);
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  });

  const manifest = await loadManifest(this.base_dir);
  const sourceAssets = await collectSourcePostAssets(this.base_dir, keyPrefix);
  const assetKeyMap = new Map(sourceAssets.map(asset => [asset.publicRelativePath, asset]));
  const htmlFiles = await collectFiles(publicDir, '.html');
  let rewrittenFiles = 0;

  for (const htmlPath of htmlFiles) {
    let html = await fs.readFile(htmlPath, 'utf8');
    let changed = false;

    const replaceAssetUrl = assetUrl => {
      const resolvedPath = resolvePublicPath(publicDir, htmlPath, assetUrl);
      if (!resolvedPath) {
        return assetUrl;
      }

      const relativePath = toPosixPath(path.relative(publicDir, resolvedPath));
      const asset = assetKeyMap.get(relativePath);
      if (!asset) {
        return assetUrl;
      }

      changed = true;
      return buildPublicUrl(publicBaseUrl, asset.objectKey);
    };

    html = html.replace(ATTR_REGEX, (fullMatch, quote, assetUrl) => {
      const replacedUrl = replaceAssetUrl(assetUrl);
      return replacedUrl === assetUrl ? fullMatch : fullMatch.replace(assetUrl, replacedUrl);
    });

    html = html.replace(SRCSET_REGEX, (fullMatch, quote, srcsetValue) => {
      const replaced = replaceSrcset(srcsetValue, replaceAssetUrl);
      return replaced === srcsetValue ? fullMatch : `srcset=${quote}${replaced}${quote}`;
    });

    if (changed) {
      await fs.writeFile(htmlPath, html);
      rewrittenFiles += 1;
    }
  }

  let uploadedCount = 0;
  let skippedCount = 0;
  for (const asset of sourceAssets) {
    const stats = await fs.stat(asset.filePath);
    const hash = await fileSha256(asset.filePath);
    const previous = manifest.assets[asset.objectKey];

    if (previous && previous.hash === hash && previous.size === stats.size) {
      skippedCount += 1;
      continue;
    }

    const body = await fs.readFile(asset.filePath);
    const contentType = mime.lookup(asset.filePath) || 'application/octet-stream';

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: asset.objectKey,
      Body: body,
      ContentType: contentType
    }));

    manifest.assets[asset.objectKey] = {
      hash,
      size: stats.size,
      updated_at: new Date().toISOString()
    };
    uploadedCount += 1;
  }

  const validKeys = new Set(sourceAssets.map(asset => asset.objectKey));
  const staleKeys = Object.keys(manifest.assets).filter(objectKey => !validKeys.has(objectKey));

  let deletedCount = 0;
  if (deleteStale && staleKeys.length > 0) {
    for (let index = 0; index < staleKeys.length; index += 1000) {
      const batch = staleKeys.slice(index, index + 1000);
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map(Key => ({ Key })),
          Quiet: true
        }
      }));
      deletedCount += batch.length;
    }
  }

  for (const objectKey of Object.keys(manifest.assets)) {
    if (!validKeys.has(objectKey)) {
      delete manifest.assets[objectKey];
    }
  }

  await saveManifest(this.base_dir, manifest);

  const removedCount = await removePublicPostAssets(this.base_dir, publicDir);

  this.log.info('R2 media deployer processed %d HTML files, uploaded %d assets, skipped %d unchanged assets, deleted %d stale R2 assets, removed %d local media files from public/.', rewrittenFiles, uploadedCount, skippedCount, deletedCount, removedCount);
});
