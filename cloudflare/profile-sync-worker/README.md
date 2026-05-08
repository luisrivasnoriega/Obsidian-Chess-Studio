# OCS Profile Sync Worker

Simple Cloudflare Worker for encrypted single-profile sync.

## Bindings

Copy `wrangler.toml.example` to `wrangler.toml`, then set:

- `PROFILE_SYNC_BUCKET`: R2 bucket binding.
- `PROFILE_SYNC_DB`: D1 database binding.
- `SYNC_AUTH_TOKEN`: optional Worker secret.

## D1 schema

Apply the schema after creating the D1 database:

```sh
wrangler d1 execute ocs-sync --file schema.sql
```

## API

- `GET /sync/profile/state?userId=...`
- `POST /sync/profile/upload?userId=...`
- `GET /sync/profile/download?userId=...`

The OCS client sends encrypted profile blobs. The Worker never receives the sync key or plaintext profile data.
