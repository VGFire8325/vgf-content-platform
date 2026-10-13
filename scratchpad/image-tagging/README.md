# Image tagging progress (resumable)

Working files for tagging asset_library images (PR #2). Thumbnails/sheets live outside the repo.

- `inventory.json`: 1,383 in-scope images (idx, kind, Shopify image id, url, width/height, product/source).
- `groups.json`: idx -> representative idx of visually identical pictures (dHash); copies inherit tags.
- `progress.json`: `pass1` setting per representative idx, `pass2` detail tags per representative idx, `notes`.
- `bin/`: scripts. Rebuild thumbs with `python3 -I bin/fetch.py 400 <dir>`; sheets with `bin/sheet.py r<page>`.
