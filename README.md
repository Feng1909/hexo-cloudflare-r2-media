# hexo-cloudflare-r2-media

A Hexo deployer plugin that uploads post asset-folder media to Cloudflare R2, rewrites generated HTML to use public R2 URLs, skips unchanged uploads with a local manifest, optionally deletes stale R2 objects, and removes those media files from `public/` before your git/static deploy step.

## Features

- Upload media from `source/_posts/*/`
- Rewrite generated HTML references to your R2 public domain
- Skip unchanged files using SHA-256 + file size
- Delete stale R2 objects that no longer exist locally
- Keep `public/` free of post media before later deployers run

## Requirements

- Node.js `>=18`
- Hexo with `post_asset_folder: true`
- A Cloudflare R2 bucket plus public custom domain or `r2.dev` URL

## Install

```bash
npm install hexo-cloudflare-r2-media
```

## Configuration

Add the plugin before your normal deployer:

```yml
r2_media:
  enable: true
  delete_stale: true
  bucket: blog
  endpoint: https://<account-id>.r2.cloudflarestorage.com
  public_base_url: https://storage-blog.example.com
  access_key_id: <r2-access-key-id>
  secret_access_key: <r2-secret-access-key>
  key_prefix: blog

deploy:
  - type: r2-media
  - type: git
    repo: git@github.com:user/user.github.io.git
    branch: master
```

You can also provide values through environment variables:

- `R2_BUCKET`
- `R2_ENDPOINT`
- `R2_PUBLIC_BASE_URL`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_KEY_PREFIX`

## How It Works

1. Scan `source/_posts/*/` for image/video assets.
2. Upload only changed files to R2 using the local manifest `.r2-media-manifest.json`.
3. Rewrite matching asset URLs in generated `public/**/*.html`.
4. Delete stale R2 objects if `delete_stale: true`.
5. Remove post media files from `public/` so later deployers do not publish them.

## Notes

- Theme assets such as `/img/*` are intentionally ignored.
- Stale-object deletion only affects objects tracked in `.r2-media-manifest.json`.
- The manifest stays in your Hexo project root and should usually be committed if you want stable incremental deploys across machines.

## Local Development

```bash
npm install
```

Then link it into a Hexo site with:

```bash
npm install ./path/to/hexo-cloudflare-r2-media
```

## Publish To npm

From the plugin directory:

```bash
npm login
npm publish
```

If you publish under an npm scope, update the package name first.

## License

MIT
